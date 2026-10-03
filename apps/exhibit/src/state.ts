/**
 * Pure exhibit state. No DOM, no three.js. `applyEvent` folds one LiveEvent into the state and
 * `tick` decays highlight intensities over time. Both return new State objects and never throw on
 * unknown or malformed events.
 */
import type { AgentName, EvidenceItem, GraphDelta, LiveEvent, RoutingDecision, VerdictTier } from './contract'
import { AGENT_NAMES } from './contract'

export type NodeType = 'customer' | 'order' | 'device' | 'address' | 'payment' | 'return' | 'dispute' | 'evidence'

export interface GNode {
  id: string
  type: NodeType
  label: string
  population?: string
  flags?: string[]
  amount?: number
  at?: string
  /** True when the node arrived through an evidence graph delta rather than the seed. */
  delta?: boolean
}

export interface GEdge {
  source: string
  target: string
  type: string
  delta?: boolean
}

export interface Graph {
  nodes: GNode[]
  edges: GEdge[]
  byId: Record<string, GNode>
}

export type AgentStatus = 'idle' | 'thinking' | 'tool' | 'posting' | 'done' | 'error'

export interface AgentState {
  name: AgentName
  joined: boolean
  handle: string | null
  status: AgentStatus
  detail: string | null
  lastMessage: string | null
  /** Count of evidence items this agent attached in the active case. */
  evidenceCount: number
  /** How the agent was woken: through the Band room or the server's in-process fallback. */
  via: 'band' | 'in-process' | null
}

export interface TranscriptLine {
  id: number
  kind: 'message' | 'status' | 'system'
  agent?: AgentName
  text: string
  mentions?: AgentName[]
  seq: number
}

export interface ActiveCase {
  case_id: string
  kind: 'return' | 'dispute'
  order_id: string
  customer_id: string
  customer_name: string
  title: string
  summary: string
  amount: number
  population: string
  flags: string[]
  room: { id: string; title: string } | null
  due_by: string | null
  closed: boolean
  outcome: string | null
}

export interface Verdict {
  tier: VerdictTier
  confidence: number
  score: number
  rationale: string
  policy_citation: string | null
  evidence_ids: string[]
}

export interface Routing {
  dispute_id: string
  decision: RoutingDecision
  rationale: string
  vamp: { ratio_before: number; ratio_after: number; threshold: number; headroom_items: number }
  expected_recovery: number
}

export interface StripePackage {
  dispute_id: string
  stripe_dispute_id: string | null
  due_by: string
  submitted: boolean
  submitted_status?: string
  submitted_at?: string
  evidence: Record<string, string>
  dashboard_url: string | null
}

export interface Checkout {
  order_id: string
  population: string
  score: number
  signals: { signal: string; detail: string; weight: number }[]
  verified: boolean | null
  signature_agent: string | null
}

export interface State {
  merchant: string | null
  serverTime: string | null
  /** Case id the server reported as active in `hello`, before we have its details. */
  activeCaseId: string | null
  seed: { nodes: GNode[]; edges: GEdge[] }
  graph: Graph
  case: ActiveCase | null
  agents: Record<AgentName, AgentState>
  evidence: (EvidenceItem & { agent?: AgentName })[]
  verdict: Verdict | null
  routing: Routing | null
  stripe: StripePackage | null
  transcript: TranscriptLine[]
  lastCheckout: Checkout | null
  /** Node id -> intensity 0..1, decays in `tick`. */
  highlights: Record<string, number>
  /** Node id -> floor the intensity decays towards while the case is on screen. */
  highlightFloor: Record<string, number>
  /** Monotonic counter of applied events. */
  seq: number
  lastEvent: LiveEvent | null
  /** Set when an event type outside the contract arrived; the UI may show it, nothing else happens. */
  unknownEvents: number
}

const SEVERITY_INTENSITY: Record<string, number> = { critical: 1, suspicious: 0.85, exculpatory: 0.7, info: 0.5 }
const DECAY_TAU_S = 3.2

function blankAgents(): Record<AgentName, AgentState> {
  const out = {} as Record<AgentName, AgentState>
  for (const name of AGENT_NAMES) out[name] = { name, joined: false, handle: null, status: 'idle', detail: null, lastMessage: null, evidenceCount: 0, via: null }
  return out
}

function buildGraph(nodes: GNode[], edges: GEdge[]): Graph {
  const byId: Record<string, GNode> = {}
  const dedupNodes: GNode[] = []
  for (const n of nodes) {
    if (!n || typeof n.id !== 'string' || byId[n.id]) continue
    byId[n.id] = n
    dedupNodes.push(n)
  }
  const seen = new Set<string>()
  const dedupEdges: GEdge[] = []
  for (const e of edges) {
    if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') continue
    if (!byId[e.source] || !byId[e.target]) continue
    const key = `${e.source}>${e.target}:${e.type}`
    if (seen.has(key)) continue
    seen.add(key)
    dedupEdges.push(e)
  }
  return { nodes: dedupNodes, edges: dedupEdges, byId }
}

export function initialState(): State {
  return {
    merchant: null,
    serverTime: null,
    activeCaseId: null,
    seed: { nodes: [], edges: [] },
    graph: buildGraph([], []),
    case: null,
    agents: blankAgents(),
    evidence: [],
    verdict: null,
    routing: null,
    stripe: null,
    transcript: [],
    lastCheckout: null,
    highlights: {},
    highlightFloor: {},
    seq: 0,
    lastEvent: null,
    unknownEvents: 0,
  }
}

/** Install the seed graph from GET /api/graph. Keeps any case state already present. */
export function seedGraph(state: State, graph: { nodes: unknown[]; edges: unknown[] }): State {
  const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter(isNodeLike) as GNode[]
  const edges = (Array.isArray(graph?.edges) ? graph.edges : []).filter(isEdgeLike) as GEdge[]
  const seed = { nodes, edges }
  // Re-apply deltas from evidence already collected so a late graph load does not drop them.
  const deltaNodes = state.graph.nodes.filter((n) => n.delta)
  const deltaEdges = state.graph.edges.filter((e) => e.delta)
  return { ...state, seed, graph: buildGraph([...nodes, ...deltaNodes], [...edges, ...deltaEdges]) }
}

function isNodeLike(n: unknown): n is GNode {
  return !!n && typeof n === 'object' && typeof (n as GNode).id === 'string' && typeof (n as GNode).type === 'string'
}
function isEdgeLike(e: unknown): e is GEdge {
  return !!e && typeof e === 'object' && typeof (e as GEdge).source === 'string' && typeof (e as GEdge).target === 'string'
}

function withDelta(graph: Graph, delta: GraphDelta | undefined): Graph {
  if (!delta || (!delta.nodes?.length && !delta.edges?.length)) return graph
  const nodes = [...graph.nodes]
  const byId = { ...graph.byId }
  for (const raw of delta.nodes ?? []) {
    if (!isNodeLike(raw)) continue
    const existing = byId[raw.id]
    if (existing) {
      // Upsert: a delta may enrich a seed node (e.g. a live population classification).
      const merged: GNode = { ...existing, label: raw.label ?? existing.label, population: raw.population ?? existing.population, flags: raw.flags ?? existing.flags }
      byId[raw.id] = merged
      const idx = nodes.findIndex((n) => n.id === raw.id)
      if (idx >= 0) nodes[idx] = merged
    } else {
      const n: GNode = { id: raw.id, type: raw.type, label: raw.label ?? raw.id, population: raw.population, flags: raw.flags, delta: true }
      byId[n.id] = n
      nodes.push(n)
    }
  }
  const edges = [...graph.edges]
  const seen = new Set(edges.map((e) => `${e.source}>${e.target}:${e.type}`))
  for (const raw of delta.edges ?? []) {
    if (!isEdgeLike(raw)) continue
    if (!byId[raw.source] || !byId[raw.target]) continue
    const key = `${raw.source}>${raw.target}:${raw.type}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ source: raw.source, target: raw.target, type: raw.type ?? 'related', delta: true })
  }
  return { nodes, edges, byId }
}

function ensureNode(graph: Graph, node: GNode): Graph {
  if (graph.byId[node.id]) return graph
  return withDelta(graph, { nodes: [{ id: node.id, type: node.type, label: node.label, population: node.population, flags: node.flags }] })
}

function lit(h: Record<string, number>, ids: string[], intensity: number): Record<string, number> {
  const out = { ...h }
  for (const id of ids) if (typeof id === 'string') out[id] = Math.max(out[id] ?? 0, intensity)
  return out
}

function floor(f: Record<string, number>, ids: string[], value: number): Record<string, number> {
  const out = { ...f }
  for (const id of ids) if (typeof id === 'string') out[id] = Math.max(out[id] ?? 0, value)
  return out
}

function line(state: State, l: Omit<TranscriptLine, 'id' | 'seq'>): TranscriptLine[] {
  const id = state.transcript.length ? state.transcript[state.transcript.length - 1].id + 1 : 1
  return [...state.transcript, { ...l, id, seq: state.seq + 1 }]
}

function isAgent(a: unknown): a is AgentName {
  return typeof a === 'string' && (AGENT_NAMES as readonly string[]).includes(a)
}

/** Clear everything case-related, keeping merchant and seed graph. */
function clearCase(state: State): State {
  return {
    ...state,
    activeCaseId: null,
    graph: buildGraph(state.seed.nodes, state.seed.edges),
    case: null,
    agents: blankAgents(),
    evidence: [],
    verdict: null,
    routing: null,
    stripe: null,
    transcript: [],
    highlights: {},
    highlightFloor: {},
  }
}

export function applyEvent(state: State, event: LiveEvent): State {
  if (!event || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') {
    return { ...state, seq: state.seq + 1, unknownEvents: state.unknownEvents + 1 }
  }
  let next: State
  try {
    next = reduce(state, event)
  } catch {
    // A malformed payload must never take the exhibit down.
    next = { ...state, unknownEvents: state.unknownEvents + 1 }
  }
  return { ...next, seq: state.seq + 1, lastEvent: event }
}

/** Event types that are not scoped to one case and therefore never carry a `case_id` we check. */
const UNSCOPED_EVENTS: ReadonlySet<string> = new Set(['hello', 'checkout.observed', 'case.opened', 'reset'])

/** True when a case-scoped event belongs to a different case than the one on screen. */
export function isForeignCaseEvent(state: State, event: LiveEvent): boolean {
  if (!state.case || UNSCOPED_EVENTS.has(event.type)) return false
  const caseId = (event as { case_id?: unknown }).case_id
  return typeof caseId === 'string' && caseId !== state.case.case_id
}

function reduce(state: State, event: LiveEvent): State {
  // Events from another case (a second war room opened elsewhere, or stragglers resumed after an
  // offline replay) must never be merged into the case on screen.
  if (isForeignCaseEvent(state, event)) return state
  switch (event.type) {
    case 'hello': {
      return { ...state, merchant: event.merchant ?? state.merchant, serverTime: event.server_time ?? null, activeCaseId: event.active_case ?? null }
    }

    case 'checkout.observed': {
      const sig = event.signature
      const checkout: Checkout = {
        order_id: event.order_id,
        population: event.population,
        score: event.score,
        signals: Array.isArray(event.signals) ? event.signals : [],
        verified: sig ? !!sig.verified : null,
        signature_agent: sig?.signature_agent ?? null,
      }
      let graph = state.graph
      let seed = state.seed
      const existing = graph.byId[event.order_id]
      if (existing) {
        graph = withDelta(graph, { nodes: [{ id: existing.id, type: existing.type as 'order', label: existing.label, population: event.population, flags: existing.flags }] })
      } else {
        const node: GNode = { id: event.order_id, type: 'order', label: event.order_id, population: event.population, flags: [] }
        graph = withDelta(graph, { nodes: [node] })
        // A checkout is a real order, not case evidence: keep it in the seed so clearCase does not drop it.
        seed = { nodes: [...seed.nodes, node], edges: seed.edges }
      }
      const text = `Checkout ${event.order_id} classified ${event.population} (score ${Number(event.score).toFixed(2)})${sig ? `, signature ${sig.verified ? 'verified' : 'rejected'} for ${sig.signature_agent}` : ''}`
      return { ...state, graph, seed, lastCheckout: checkout, highlights: lit(state.highlights, [event.order_id], 1), transcript: line(state, { kind: 'system', text }) }
    }

    case 'case.opened': {
      if (typeof event.case_id !== 'string' || typeof event.order_id !== 'string' || typeof event.customer_id !== 'string') throw new Error('malformed case.opened')
      const base = clearCase(state)
      let graph = base.graph
      graph = ensureNode(graph, { id: event.customer_id, type: 'customer', label: event.customer_name ?? event.customer_id })
      graph = ensureNode(graph, { id: event.order_id, type: 'order', label: event.order_id, population: event.population, flags: event.flags })
      graph = withDelta(graph, { edges: [{ source: event.customer_id, target: event.order_id, type: 'placed' }] })
      const activeCase: ActiveCase = {
        case_id: event.case_id,
        kind: event.kind,
        order_id: event.order_id,
        customer_id: event.customer_id,
        customer_name: event.customer_name,
        title: event.title,
        summary: event.summary,
        amount: Number(event.amount) || 0,
        population: event.population,
        flags: Array.isArray(event.flags) ? event.flags : [],
        room: event.room ?? null,
        due_by: event.due_by ?? null,
        closed: false,
        outcome: null,
      }
      const ids = [event.order_id, event.customer_id]
      return {
        ...base,
        graph,
        activeCaseId: event.case_id,
        case: activeCase,
        highlights: lit({}, ids, 1),
        highlightFloor: floor({}, [event.order_id], 0.55),
        transcript: line({ ...base, transcript: [] }, { kind: 'system', text: `${event.kind === 'dispute' ? 'Dispute' : 'Return'} opened: ${event.title}` }),
      }
    }

    case 'agent.joined': {
      if (!isAgent(event.agent)) return state
      const agents = { ...state.agents, [event.agent]: { ...state.agents[event.agent], joined: true, handle: event.handle ?? null, status: 'idle' as AgentStatus, via: event.via === 'band' || event.via === 'in-process' ? event.via : null } }
      return { ...state, agents, transcript: line(state, { kind: 'status', agent: event.agent, text: 'joined the room' }) }
    }

    case 'agent.status': {
      if (!isAgent(event.agent)) return state
      const status: AgentStatus = ['thinking', 'tool', 'posting', 'done', 'error'].includes(event.status) ? event.status : 'idle'
      const agents = { ...state.agents, [event.agent]: { ...state.agents[event.agent], joined: true, status, detail: event.detail ?? null } }
      const text = status === 'tool' ? `ran ${event.detail ?? 'a tool'}` : status === 'thinking' ? (event.detail ? `thinking: ${event.detail}` : 'thinking') : status === 'error' ? `error${event.detail ? `: ${event.detail}` : ''}` : status === 'done' ? 'done' : 'posting'
      const transcript = status === 'posting' ? state.transcript : line(state, { kind: 'status', agent: event.agent, text })
      return { ...state, agents, transcript }
    }

    case 'agent.message': {
      if (!isAgent(event.agent)) return state
      const agents = { ...state.agents, [event.agent]: { ...state.agents[event.agent], joined: true, lastMessage: event.text, status: 'posting' as AgentStatus } }
      const mentions = Array.isArray(event.mentions) ? event.mentions.filter(isAgent) : []
      return { ...state, agents, transcript: line(state, { kind: 'message', agent: event.agent, text: event.text ?? '', mentions }) }
    }

    case 'evidence.attached': {
      const ev = event.evidence
      if (!ev || typeof ev.id !== 'string') return state
      const nodeIds = Array.isArray(ev.node_ids) ? ev.node_ids.filter((x): x is string => typeof x === 'string') : []
      const already = state.evidence.some((e) => e.id === ev.id)
      const tagged = { ...ev, agent: isAgent(event.agent) ? event.agent : undefined } as EvidenceItem & { agent?: AgentName }
      const evidence = already ? state.evidence.map((e) => (e.id === ev.id ? tagged : e)) : [...state.evidence, tagged]
      let graph = withDelta(state.graph, ev.graph)
      // A newly surfaced shared sandbox lights up every seed device in the same cluster: the ring reveal.
      const clusterReveal = (ev.graph?.nodes ?? []).some((n) => n.population === 'cluster')
      const clusterIds = clusterReveal ? graph.nodes.filter((n) => n.population === 'cluster').map((n) => n.id) : []
      const agents = isAgent(event.agent)
        ? { ...state.agents, [event.agent]: { ...state.agents[event.agent], joined: true, evidenceCount: state.agents[event.agent].evidenceCount + (already ? 0 : 1) } }
        : state.agents
      const intensity = SEVERITY_INTENSITY[ev.severity] ?? 0.6
      const presentIds = nodeIds.filter((id) => graph.byId[id])
      const label = ev.label ?? ev.id
      return {
        ...state,
        graph,
        evidence,
        agents,
        highlights: lit(lit(state.highlights, presentIds, intensity), clusterIds, 0.6),
        highlightFloor: floor(state.highlightFloor, presentIds, 0.28),
        transcript: line(state, { kind: 'status', agent: isAgent(event.agent) ? event.agent : undefined, text: `attached ${ev.severity} evidence: ${label}` }),
      }
    }

    case 'verdict': {
      const verdict: Verdict = {
        tier: event.tier,
        confidence: Number(event.confidence) || 0,
        score: Number(event.score) || 0,
        rationale: event.rationale ?? '',
        policy_citation: event.policy_citation ?? null,
        evidence_ids: Array.isArray(event.evidence_ids) ? event.evidence_ids : [],
      }
      const touched = new Set<string>()
      for (const e of state.evidence) if (verdict.evidence_ids.includes(e.id)) for (const id of e.node_ids ?? []) touched.add(id)
      if (state.case) touched.add(state.case.order_id)
      const agents = { ...state.agents, critic: { ...state.agents.critic, status: 'done' as AgentStatus } }
      return { ...state, verdict, agents, highlights: lit(state.highlights, [...touched], 1), transcript: line(state, { kind: 'system', text: `Verdict: ${event.tier.replace(/_/g, ' ')} (${Math.round(verdict.confidence * 100)}% confidence)` }) }
    }

    case 'dispute.routing': {
      const routing: Routing = {
        dispute_id: event.dispute_id,
        decision: event.decision,
        rationale: event.rationale ?? '',
        vamp: event.vamp ?? { ratio_before: 0, ratio_after: 0, threshold: 0, headroom_items: 0 },
        expected_recovery: Number(event.expected_recovery) || 0,
      }
      const ids = state.graph.byId[event.dispute_id] ? [event.dispute_id] : []
      return { ...state, routing, highlights: lit(state.highlights, ids, 0.9), transcript: line(state, { kind: 'system', text: `Routing: ${event.decision.replace(/_/g, ' ')} · expected recovery $${routing.expected_recovery.toFixed(0)}` }) }
    }

    case 'stripe.evidence_staged': {
      const stripe: StripePackage = {
        dispute_id: event.dispute_id,
        stripe_dispute_id: event.stripe_dispute_id ?? null,
        due_by: event.due_by,
        submitted: false,
        evidence: event.evidence && typeof event.evidence === 'object' ? event.evidence : {},
        dashboard_url: event.dashboard_url ?? null,
      }
      return { ...state, stripe, transcript: line(state, { kind: 'system', text: `Stripe evidence staged for ${event.dispute_id}, not submitted. Due ${event.due_by}` }) }
    }

    case 'stripe.submitted': {
      if (!state.stripe) return state
      const stripe: StripePackage = { ...state.stripe, submitted: true, submitted_status: event.status, submitted_at: event.submitted_at, stripe_dispute_id: event.stripe_dispute_id ?? state.stripe.stripe_dispute_id, dashboard_url: event.dashboard_url ?? state.stripe.dashboard_url }
      const c = state.case && state.case.case_id === event.case_id ? { ...state.case, outcome: `submitted to Stripe (${event.status})` } : state.case
      return { ...state, stripe, case: c, transcript: line(state, { kind: 'system', text: `Evidence submitted to Stripe. Dispute status: ${event.status.replace(/_/g, ' ')}` }) }
    }

    case 'case.closed': {
      const c = state.case && state.case.case_id === event.case_id ? { ...state.case, closed: true, outcome: event.outcome ?? null } : state.case
      const agents = { ...state.agents }
      for (const name of AGENT_NAMES) if (agents[name].joined) agents[name] = { ...agents[name], status: 'done' }
      return { ...state, case: c, agents, transcript: line(state, { kind: 'system', text: `Case closed: ${event.outcome ?? ''}` }) }
    }

    case 'reset': {
      return { ...clearCase(state), lastCheckout: null }
    }

    default: {
      // Unknown type: the contract may grow before the exhibit does.
      return { ...state, unknownEvents: state.unknownEvents + 1 }
    }
  }
}

/** Decay highlight intensities towards their floor. `dt` in seconds. */
export function tick(state: State, dt: number): State {
  const ids = Object.keys(state.highlights)
  if (!ids.length) return state
  const k = Math.exp(-Math.max(0, dt) / DECAY_TAU_S)
  const highlights: Record<string, number> = {}
  let changed = false
  for (const id of ids) {
    const f = state.highlightFloor[id] ?? 0
    const v = state.highlights[id]
    const nv = f + (v - f) * k
    if (nv > 0.015 || f > 0) highlights[id] = nv
    if (Math.abs(nv - v) > 1e-4 || !(nv > 0.015 || f > 0)) changed = true
  }
  return changed ? { ...state, highlights } : state
}

/** Convenience: ids of the evidence that touched a node. */
export function evidenceForNode(state: State, nodeId: string): EvidenceItem[] {
  return state.evidence.filter((e) => (e.node_ids ?? []).includes(nodeId))
}

export function hasLiveCase(state: State): boolean {
  return !!state.case && !state.case.closed
}
