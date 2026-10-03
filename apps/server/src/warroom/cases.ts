import { AGENT_NAMES, type AgentName, type EvidenceItem, type EvidenceVault, type LiveEvent, type RoutingDecision, type VerdictTier } from '@receipts/seed'
import { data, vaultFor, vaults } from '../store.js'
import { runTurn } from '../zoowork.js'
import { AGENT_IDS } from './agents.js'
import { buildEvidencePackage, stageOnStripe, submitOnStripe } from './stripe.js'
import { DECISIONS, TIERS, executeTool, type ToolContext } from './tools.js'

export type Broadcast = (ev: LiveEvent) => void
let broadcastFn: Broadcast = () => {}
export function setBroadcast(fn: Broadcast): void {
  broadcastFn = fn
}

/** Message transport between agents. Band in production; null falls back to in-process dispatch. */
export interface Transport {
  post(from: AgentName, text: string, mentions: AgentName[]): Promise<string | undefined>
  room(): { id: string; title: string } | null
}
let transport: Transport | null = null
export function setTransport(t: Transport | null): void {
  transport = t
}

const SPECIALISTS: AgentName[] = ['history', 'logistics', 'identity', 'forensics']
const SPECIALIST_TIMEOUT_MS = 110_000
const CRITIC_TIMEOUT_MS = 90_000
const CASE_DEADLINE_MS = 170_000
const BAND_GRACE_MS = 8_000
/** If a specialist has not been woken through Band by then, run it in-process. Band stays the transport for replies. */
const BAND_WAKE_GRACE_MS = 12_000

export interface CaseRecord {
  id: string
  kind: 'return' | 'dispute'
  order_id: string
  customer_id: string
  dispute_id?: string
  return_id?: string
  opened_at: string
  vault: EvidenceVault
  agents: Record<AgentName, { status: string; replied: boolean; summary?: string }>
  evidence: EvidenceItem[]
  verdict?: { tier: VerdictTier; confidence: number; score: number; rationale: string; policy_citation?: string }
  routing?: { decision: RoutingDecision; rationale: string; vamp: { ratio_before: number; ratio_after: number; threshold: number; headroom_items: number }; expected_recovery: number }
  stripe?: { stripe_dispute_id?: string; dashboard_url?: string; due_by: string; evidence: Record<string, string>; submitted?: { at: string; status: string } }
  closed_at?: string
  outcome?: string
  events: LiveEvent[]
}

const cases = new Map<string, CaseRecord>()
const timers = new Map<string, NodeJS.Timeout[]>()
/** One controller per open case; reset aborts the in-flight ZooWork turns so they stop billing and stop posting to Band. */
const aborts = new Map<string, AbortController>()
/** In-flight Stripe submissions, so a double click does not race two updates. */
const submitting = new Map<string, Promise<{ status: string }>>()
/** Closed cases kept in memory for GET /api/cases and the queue; older ones are evicted. */
const MAX_CASES = 50
let activeCaseId: string | null = null
let seq = 0

export const listCases = (): CaseRecord[] => [...cases.values()]
export const getCase = (id: string): CaseRecord | undefined => cases.get(id)
export const activeCase = (): CaseRecord | null => (activeCaseId ? cases.get(activeCaseId) ?? null : null)

export function resetCases(): void {
  for (const ts of timers.values()) ts.forEach(clearTimeout)
  timers.clear()
  for (const ac of aborts.values()) ac.abort()
  aborts.clear()
  cases.clear()
  activeCaseId = null
  broadcastFn({ type: 'reset' })
}

function emit(c: CaseRecord, ev: LiveEvent): void {
  if (!cases.has(c.id)) return // case was reset while an agent was still running
  c.events.push(ev)
  broadcastFn(ev)
}

function later(c: CaseRecord, ms: number, fn: () => void): void {
  if (!cases.has(c.id)) return // case was reset while an await was pending
  const t = setTimeout(fn, ms)
  timers.set(c.id, [...(timers.get(c.id) ?? []), t])
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const money = (n: number) => `$${n.toFixed(2)}`

function brief(c: CaseRecord): string {
  const v = c.vault
  const head = `Case ${c.id} (case:${c.id}): ${c.kind} on order ${c.order_id}, customer ${v.customer_name} (${c.customer_id}), order total ${money(v.total)}, placed ${v.placed_at.slice(0, 10)}.`
  if (c.kind === 'dispute') {
    const d = v.disputes.find((x) => x.id === c.dispute_id)!
    return `${head}\nDispute ${d.id}: ${d.network} reason code ${d.reason_code} (${d.reason}), amount ${money(d.amount)}, status ${d.status}${d.is_inquiry ? ' (inquiry, pre-dispute)' : ''}, evidence due ${d.evidence_due_by.slice(0, 10)}. Cardholder statement: "${d.cardholder_statement}".\nRelated: returns ${v.returns.map((r) => r.id).join(', ') || 'none'}.`
  }
  const r = v.returns.find((x) => x.id === c.return_id)!
  const raw = data.returns.find((x) => x.id === r.id)!
  return `${head}\nReturn ${r.id}: ${r.kind} (${r.reason}), amount ${money(r.amount)}, submitted via ${r.via} on ${r.requested_at.slice(0, 10)}, status ${r.status}. Claim text: "${raw.claim_text}".\nRelated: disputes ${v.disputes.map((d) => d.id).join(', ') || 'none'}.`
}

export async function openCase(input: { dispute_id?: string; return_id?: string }): Promise<CaseRecord> {
  let orderId: string | undefined
  let kind: 'return' | 'dispute'
  if (input.dispute_id) {
    orderId = data.disputes.find((d) => d.id === input.dispute_id)?.order_id
    kind = 'dispute'
  } else if (input.return_id) {
    orderId = data.returns.find((r) => r.id === input.return_id)?.order_id
    kind = 'return'
  } else throw new Error('dispute_id or return_id required')
  if (!orderId) throw new Error('unknown dispute or return')
  const running = activeCase()
  if (running && !running.closed_at) throw new Error('case_running')
  const vault = vaultFor(orderId)!
  const id = `case_${Date.now().toString(36)}_${++seq}`
  const c: CaseRecord = {
    id,
    kind,
    order_id: orderId,
    customer_id: vault.customer_id,
    dispute_id: input.dispute_id,
    return_id: input.return_id,
    opened_at: new Date().toISOString(),
    vault,
    agents: Object.fromEntries(AGENT_NAMES.map((a) => [a, { status: 'idle', replied: false }])) as CaseRecord['agents'],
    evidence: [],
    events: [],
  }
  cases.set(id, c)
  aborts.set(id, new AbortController())
  activeCaseId = id

  const d = kind === 'dispute' ? vault.disputes.find((x) => x.id === input.dispute_id)! : undefined
  const r = kind === 'return' ? vault.returns.find((x) => x.id === input.return_id)! : undefined
  emit(c, {
    type: 'case.opened',
    case_id: id,
    kind,
    order_id: orderId,
    customer_id: vault.customer_id,
    customer_name: vault.customer_name,
    title: d ? `Chargeback ${d.id} · ${d.network} ${d.reason_code} ${d.reason} · ${money(d.amount)}` : `${r!.kind.replace('_', ' ')} ${r!.id} · ${r!.reason} · ${money(r!.amount)}`,
    summary: d ? `Cardholder says: "${d.cardholder_statement}"${vault.returns.some((x) => x.refund) ? ' A return on this order was already refunded.' : ''}` : `Claim: "${data.returns.find((x) => x.id === r!.id)!.claim_text}"`,
    amount: d ? d.amount : r!.amount,
    population: vault.population,
    flags: vault.flags,
    room: transport?.room() ?? null,
    due_by: d?.evidence_due_by,
  })

  // Critic kicks off: the brief goes to the room, mentions wake the specialists.
  emit(c, { type: 'agent.joined', case_id: id, agent: 'critic', handle: 'critic-agent', via: transport ? 'band' : 'in-process' })
  c.agents.critic.status = 'posting'
  const kickoff = `${brief(c)}\n@history pull the customer record. @identity classify the session and check linkage. @logistics trace delivery and any return. @forensics inspect the claim.`
  let bandId: string | undefined
  if (transport) {
    try {
      bandId = await transport.post('critic', kickoff, SPECIALISTS)
    } catch (err) {
      console.warn('[warroom] Band post failed, dispatching in-process:', (err as Error).message)
    }
  }
  emit(c, { type: 'agent.message', case_id: id, agent: 'critic', text: kickoff.split('\n').slice(-1)[0], mentions: SPECIALISTS, band_message_id: bandId })
  if (!bandId) for (const role of SPECIALISTS) void runSpecialist(id, role).then(() => markReplied(id, role))
  else
    later(c, BAND_WAKE_GRACE_MS, () => {
      for (const role of SPECIALISTS)
        if (c.agents[role].status === 'idle') {
          console.warn(`[warroom] Band wake-up for ${role} not seen after ${BAND_WAKE_GRACE_MS / 1000}s, running in-process`)
          void runSpecialist(id, role)
        }
    })

  later(c, CASE_DEADLINE_MS, () => void finishCase(id, 'deadline'))
  return c
}

function fallbackEvidence(role: AgentName, v: EvidenceVault): Omit<EvidenceItem, 'id'>[] {
  const h = v.customer_history
  switch (role) {
    case 'history':
      return [{ family: 'customer_history', label: h.account_age_days > 365 && h.return_rate < 0.15 ? `Established account, ${h.orders} orders, ${Math.round(h.return_rate * 100)}% returns` : `Account ${h.account_age_days} days old, ${h.orders} order(s), ${h.returns + h.inr_claims + h.damage_claims} claim(s)`, detail: `Return rate ${Math.round(h.return_rate * 100)}%, refund ratio ${Math.round(h.refund_ratio * 100)}%. ${v.ce3.reason}`, severity: h.account_age_days > 365 && h.return_rate < 0.15 ? 'exculpatory' : h.first_order ? 'suspicious' : 'info', weight: h.account_age_days > 365 && h.return_rate < 0.15 ? -0.3 : h.first_order ? 0.15 : 0, node_ids: [v.customer_id, v.order_id] }]
    case 'logistics': {
      const items: Omit<EvidenceItem, 'id'>[] = [{ family: 'delivery', label: v.delivery.delivered_at ? `Delivered via ${v.delivery.carrier} with ${v.delivery.proof_of_delivery} proof` : 'No delivery proof', detail: v.delivery.delivered_at ? `Delivered ${v.delivery.delivered_at.slice(0, 10)}, address ${v.delivery.delivery_address_match ? 'matches' : 'mismatch'}.` : 'Carrier shows no delivery scan.', severity: v.delivery.delivered_at ? 'exculpatory' : 'suspicious', weight: v.delivery.delivered_at ? -0.2 : 0.2, node_ids: [v.order_id] }]
      for (const r of v.returns) {
        if (r.inbound_weight_ratio != null && r.inbound_weight_ratio < 0.35) items.push({ family: 'logistics', label: 'Empty box: inbound weight far below expected', detail: `Return ${r.id} parcel weighed ${(r.inbound_weight_ratio * 100).toFixed(0)}% of the expected SKU weight.`, severity: 'critical', weight: 0.5, node_ids: [v.order_id, r.id] })
        if (r.refund && v.disputes.length) items.push({ family: 'double_dip', label: 'Refund already issued, now disputed', detail: `${r.id} refunded ${money(r.refund.amount)} on ${r.refund.issued_at.slice(0, 10)} (trigger ${r.refund.trigger}${r.scan_to_refund_minutes != null ? `, ${r.scan_to_refund_minutes} min after first scan` : ''}); a dispute now claims the same charge.`, severity: 'critical', weight: 0.5, node_ids: [v.order_id, r.id] })
      }
      return items
    }
    case 'identity': {
      const items: Omit<EvidenceItem, 'id'>[] = []
      const top = v.population_signals[0]
      items.push({ family: 'agent_identity', label: v.population === 'signed' ? 'Signed agent with passkey-authenticated TAP token' : v.population === 'undeclared-suspected' ? 'Undeclared agent session' : v.population === 'declared' ? 'Declared but unsigned agent' : 'Human browser session', detail: top ? top.detail : 'Residential IP, normal pointer telemetry, stable device.', severity: v.population === 'signed' ? 'exculpatory' : v.population === 'undeclared-suspected' ? 'suspicious' : 'info', weight: v.population === 'signed' ? -0.3 : v.population === 'undeclared-suspected' ? 0.25 : 0, node_ids: [v.order_id, v.session.device_id] })
      const linked = [...new Set([...v.linkage.shared_device_customers, ...v.linkage.shared_address_customers])]
      if (linked.length >= 2) items.push({ family: 'identity_linkage', label: `${linked.length} other accounts share this device or address`, detail: `Linked accounts: ${linked.join(', ')}.`, severity: 'critical', weight: 0.45, node_ids: [v.customer_id, ...linked] })
      return items
    }
    case 'forensics': {
      const items: Omit<EvidenceItem, 'id'>[] = []
      for (const r of v.returns) {
        if (r.photo_findings.length) items.push({ family: 'claim_artifacts', label: 'Photo forensics flagged', detail: r.photo_findings.join('; '), severity: r.photo_findings.some((f) => f.includes('watermark') || f.includes('duplicated')) ? 'critical' : 'suspicious', weight: r.photo_findings.some((f) => f.includes('watermark')) ? 0.45 : 0.15, node_ids: [r.id] })
        if (r.claim_findings.length) items.push({ family: 'claim_artifacts', label: 'Claim text patterns', detail: r.claim_findings.join('; '), severity: 'suspicious', weight: 0.15, node_ids: [r.id] })
      }
      for (const d of v.disputes) if (/assistant|agent|ai\b/i.test(d.cardholder_statement)) items.push({ family: 'claim_artifacts', label: '"My agent did it" statement', detail: `Cardholder attributes the purchase to an AI assistant. Under the agent provider's terms and UETA the user is responsible for transactions their agent makes.`, severity: 'suspicious', weight: 0.2, node_ids: [d.id] })
      if (!items.length) items.push({ family: 'claim_artifacts', label: 'Claim reads as genuine', detail: 'No synthetic-photo markers, no policy-lawyer phrasing, submitted by the account holder.', severity: 'exculpatory', weight: -0.15, node_ids: [v.order_id] })
      return items
    }
    default:
      return []
  }
}

/** Content words only: purely numeric tokens (years, amounts, minutes) are shared by unrelated findings. */
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !/^\d+$/.test(w)))
function similar(a: string, b: string): boolean {
  const wa = words(a), wb = words(b)
  if (!wa.size || !wb.size) return false
  let inter = 0
  for (const w of wa) if (wb.has(w)) inter++
  return inter / Math.min(wa.size, wb.size) >= 0.6
}

function attach(c: CaseRecord, agent: AgentName, item: Omit<EvidenceItem, 'id'>): EvidenceItem {
  const dup = c.evidence.find((e) => e.family === item.family && similar(e.label, item.label) && similar(e.detail, item.detail))
  if (dup) return { ...dup, id: `dup:${dup.id}` }
  const ev: EvidenceItem = { id: `ev_${c.evidence.length + 1}_${agent}`, ...item, node_ids: item.node_ids.length ? item.node_ids : [c.order_id] }
  c.evidence.push(ev)
  emit(c, { type: 'evidence.attached', case_id: c.id, agent, evidence: ev })
  return ev
}

export async function runSpecialist(caseId: string, role: AgentName, via: 'band' | 'in-process' = 'in-process'): Promise<void> {
  const c = cases.get(caseId)
  if (!c || c.closed_at || c.agents[role].status !== 'idle') return
  c.agents[role].status = 'thinking'
  emit(c, { type: 'agent.joined', case_id: c.id, agent: role, handle: `${role}-agent`, via })
  emit(c, { type: 'agent.status', case_id: c.id, agent: role, status: 'thinking' })
  const ctx: ToolContext = { caseId, orderId: c.order_id, agent: role, attach: (a, item) => attach(c, a, item), verdict: () => ({ ok: false, error: 'not the critic' }), route: () => ({ ok: false, error: 'not the critic' }) }
  const prompt = `${brief(c)}\n\nYou are ${role}. Investigate with your tools, attach your findings, then reply to the Critic in at most two sentences.`
  let summary: string | undefined
  const mine = () => c.evidence.filter((e) => e.id.endsWith(`_${role}`))
  try {
    const agentId = AGENT_IDS.get(role)
    if (!agentId) throw new Error('agent not provisioned')
    summary = (await runTurn(agentId, prompt, (name, input) => executeTool(ctx, name, input), {
      timeoutMs: SPECIALIST_TIMEOUT_MS,
      signal: aborts.get(caseId)?.signal,
      onTool: (name, input) => emit(c, { type: 'agent.status', case_id: c.id, agent: role, status: 'tool', detail: `${name}(${Object.values(input).map(String).join(', ').slice(0, 60)})` }),
    })).trim()
    if (!cases.has(caseId)) return // reset while the turn was running
    if (!mine().length) for (const item of fallbackEvidence(role, c.vault)) attach(c, role, item)
  } catch (err) {
    if (!cases.has(caseId)) return // reset while the turn was running
    console.warn(`[warroom] ${role} failed on ${caseId}:`, (err as Error).message)
    emit(c, { type: 'agent.status', case_id: c.id, agent: role, status: 'error', detail: (err as Error).message })
    if (!mine().length) for (const item of fallbackEvidence(role, c.vault)) attach(c, role, item)
    summary = mine().map((e) => e.label).join('. ') + '.'
  }
  if (!summary) summary = mine().length ? mine().map((e) => e.label).join('. ') + '.' : 'Findings attached.'
  c.agents[role].summary = summary
  c.agents[role].status = 'done'
  emit(c, { type: 'agent.status', case_id: c.id, agent: role, status: 'posting' })
  let bandId: string | undefined
  if (transport) {
    try {
      bandId = await transport.post(role, `${summary} (case:${c.id})`, ['critic'])
    } catch (err) {
      console.warn('[warroom] Band post failed:', (err as Error).message)
    }
  }
  emit(c, { type: 'agent.message', case_id: c.id, agent: role, text: summary, mentions: ['critic'], band_message_id: bandId })
  emit(c, { type: 'agent.status', case_id: c.id, agent: role, status: 'done' })
  if (!bandId) markReplied(caseId, role)
  else later(c, BAND_GRACE_MS, () => markReplied(caseId, role)) // Band delivery normally marks it sooner
}

/** Called when the critic receives a specialist's message through the room (or by the in-process fallback). */
export function markReplied(caseId: string, role: AgentName): void {
  const c = cases.get(caseId)
  if (!c || c.closed_at) return
  c.agents[role].replied = true
  if (SPECIALISTS.every((r) => c.agents[r].replied)) void finishCase(caseId, 'all_replied')
}

function suggestedTier(score: number): VerdictTier {
  if (score >= 0.6) return 'decline'
  if (score >= 0.35) return 'require_verification'
  if (score >= 0.15) return 'refund_on_inspection'
  if (score >= 0) return 'exchange_first'
  return 'instant_refund'
}

function decideRouting(c: CaseRecord, tier: VerdictTier, override?: RoutingDecision): NonNullable<CaseRecord['routing']> {
  const v = c.vault
  const d = v.disputes.find((x) => x.id === c.dispute_id)!
  const m = data.merchant.vamp
  const items = m.tc40 + m.tc15
  const ratioBefore = Math.round((items / m.tc05) * 10000) / 10000
  const headroom = Math.floor(m.threshold * m.tc05) - items
  const delivered = Boolean(v.delivery.delivered_at && v.delivery.delivery_address_match)
  const priorRefund = v.returns.some((r) => r.refund)
  const strong = (v.ce3.eligible && delivered) || (priorRefund && delivered) || (v.population === 'signed' && Boolean(v.agent_identity?.visa_tap) && delivered)
  let decision: RoutingDecision
  let rationale: string
  if (override) {
    decision = override
    rationale = 'Critic override.'
  } else if ((tier === 'decline' || tier === 'require_verification') && strong) {
    decision = 'representment'
    rationale = priorRefund ? 'A refund was already issued for this charge and delivery is proven; refund-and-close would pay twice.' : v.ce3.eligible ? 'CE 3.0 qualifies: prior undisputed transactions match on device and account.' : 'Passkey-authenticated agent token and signed mandate prove the cardholder authorised this purchase.'
  } else if (tier === 'instant_refund' || tier === 'exchange_first') {
    decision = 'refund_and_close'
    rationale = 'The claim looks legitimate; refunding ends the dispute cheaply.'
  } else if (d.is_inquiry && (d.amount <= 100 || headroom <= 3)) {
    decision = 'refund_and_close'
    rationale = d.amount <= 100 ? `An inquiry on ${money(d.amount)} costs less to refund than a VAMP item (about $8) plus the representment effort.` : `Only ${headroom} items of VAMP headroom remain; refunding the inquiry keeps it out of the count.`
  } else if (!strong && !d.is_inquiry) {
    decision = 'representment'
    rationale = 'The chargeback is already counted; representment costs little and delivery evidence gives a partial chance.'
  } else {
    decision = 'representment'
    rationale = 'Evidence supports fighting the dispute.'
  }
  let ratioAfter = ratioBefore
  if (d.is_inquiry && decision !== 'refund_and_close') ratioAfter = Math.round(((items + 1) / m.tc05) * 10000) / 10000
  const expected = decision === 'representment' ? Math.round(d.amount * (strong ? 0.7 : 0.3)) : decision === 'refund_and_close' ? 0 : 0
  return { decision, rationale, vamp: { ratio_before: ratioBefore, ratio_after: ratioAfter, threshold: m.threshold, headroom_items: headroom }, expected_recovery: expected }
}

async function finishCase(caseId: string, why: string): Promise<void> {
  const c = cases.get(caseId)
  if (!c || c.closed_at || c.agents.critic.status === 'thinking' || c.verdict) return
  c.agents.critic.status = 'thinking'
  console.log(`[warroom] finishing ${caseId} (${why})`)
  for (const role of SPECIALISTS) if (c.agents[role].status === 'idle' || c.agents[role].status === 'thinking') {
    if (!c.evidence.some((e) => e.id.endsWith(`_${role}`))) for (const item of fallbackEvidence(role, c.vault)) attach(c, role, item)
    c.agents[role].status = 'done'
  }
  emit(c, { type: 'agent.status', case_id: c.id, agent: 'critic', status: 'thinking', detail: `weighing ${c.evidence.length} evidence items` })
  const score = Math.round(Math.tanh(c.evidence.reduce((s, e) => s + e.weight, 0)) * 100) / 100
  const suggested = suggestedTier(score)
  const suggestedRouting = c.kind === 'dispute' ? decideRouting(c, suggested) : undefined
  const evidenceText = c.evidence.map((e) => `- [${e.severity}, weight ${e.weight > 0 ? '+' : ''}${e.weight}] ${e.label}: ${e.detail}`).join('\n')
  const summaries = SPECIALISTS.map((r) => `${r}: ${c.agents[r].summary ?? '(no summary)'}`).join('\n')
  const prompt = `${brief(c)}\n\nEvidence on file (${c.evidence.length} items, net score ${score}):\n${evidenceText}\n\nSpecialist summaries:\n${summaries}\n\nSuggested tier from the score: ${suggested}.${suggestedRouting ? ` Suggested dispute routing: ${suggestedRouting.decision} (${suggestedRouting.rationale} VAMP ratio ${suggestedRouting.vamp.ratio_before} -> ${suggestedRouting.vamp.ratio_after} against threshold ${suggestedRouting.vamp.threshold}, ${suggestedRouting.vamp.headroom_items} items of headroom.)` : ''}\nCall issue_verdict${c.kind === 'dispute' ? ' and route_dispute' : ''}, then reply in one sentence.`

  let routingOverride: RoutingDecision | undefined
  let routingRationale: string | undefined
  const ctx: ToolContext = {
    caseId,
    orderId: c.order_id,
    agent: 'critic',
    attach: (a, item) => attach(c, a, item),
    verdict: (input) => {
      if (c.verdict) return { ok: false, error: 'verdict already issued' }
      if (!TIERS.includes(input.tier)) return { ok: false, error: `tier must be one of ${TIERS.join(', ')}` }
      if (typeof input.rationale !== 'string' || !input.rationale.trim()) return { ok: false, error: 'rationale is required' }
      c.verdict = { tier: input.tier, confidence: clamp(Number(input.confidence) || 0.5, 0, 1), score, rationale: input.rationale.trim(), policy_citation: typeof input.policy_citation === 'string' ? input.policy_citation : undefined }
      emit(c, { type: 'verdict', case_id: c.id, ...c.verdict, evidence_ids: c.evidence.map((e) => e.id) })
      return { ok: true }
    },
    route: (input) => {
      if (!DECISIONS.includes(input.decision)) return { ok: false, error: `decision must be one of ${DECISIONS.join(', ')}` }
      routingOverride = input.decision
      routingRationale = typeof input.rationale === 'string' && input.rationale.trim() ? input.rationale.trim() : undefined
      return { ok: true }
    },
  }
  let finalText = ''
  try {
    const agentId = AGENT_IDS.get('critic')
    if (!agentId) throw new Error('critic not provisioned')
    finalText = (await runTurn(agentId, prompt, (name, input) => executeTool(ctx, name, input), {
      timeoutMs: CRITIC_TIMEOUT_MS,
      signal: aborts.get(caseId)?.signal,
      onTool: (name) => emit(c, { type: 'agent.status', case_id: c.id, agent: 'critic', status: 'tool', detail: name }),
    })).trim()
  } catch (err) {
    if (!cases.has(caseId)) return // reset while the critic was running: no routing, no Stripe, no Band post
    console.warn(`[warroom] critic failed on ${caseId}:`, (err as Error).message)
    emit(c, { type: 'agent.status', case_id: c.id, agent: 'critic', status: 'error', detail: (err as Error).message })
  }
  if (!cases.has(caseId)) return // reset while the critic was running
  if (!c.verdict) {
    const top = [...c.evidence].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 3)
    c.verdict = { tier: suggested, confidence: 0.6, score, rationale: `Score ${score} from ${c.evidence.length} findings. Decisive: ${top.map((e) => e.label).join('; ')}.`, policy_citation: suggested === 'decline' ? `Return policy ${c.vault.policy_snapshot.version}` : undefined }
    emit(c, { type: 'verdict', case_id: c.id, ...c.verdict, evidence_ids: c.evidence.map((e) => e.id) })
  }
  if (c.kind === 'dispute') {
    const routing = decideRouting(c, c.verdict.tier, routingOverride)
    if (routingOverride && routingRationale) routing.rationale = routingRationale
    c.routing = routing
    emit(c, { type: 'dispute.routing', case_id: c.id, dispute_id: c.dispute_id!, ...routing })
    if (routing.decision === 'representment') {
      try {
        await stageEvidence(c)
      } catch (err) {
        console.warn('[warroom] evidence staging failed:', (err as Error).message)
      }
    }
  }
  const closing = finalText || `Verdict: ${c.verdict.tier.replace(/_/g, ' ')}${c.routing ? `, ${c.routing.decision.replace(/_/g, ' ')} on ${c.dispute_id}` : ''}.`
  if (!cases.has(caseId)) return // reset during Stripe staging
  let bandId: string | undefined
  if (transport) {
    try {
      bandId = await transport.post('critic', `[verdict] ${closing} (case:${c.id})`, SPECIALISTS)
    } catch (err) {
      console.warn('[warroom] Band post failed:', (err as Error).message)
    }
  }
  emit(c, { type: 'agent.message', case_id: c.id, agent: 'critic', text: closing, mentions: [], band_message_id: bandId })
  c.agents.critic.status = 'done'
  c.closed_at = new Date().toISOString()
  c.outcome = c.routing ? `${c.routing.decision}${c.stripe ? ' staged on Stripe; awaiting merchant approval' : ''}` : c.verdict.tier
  emit(c, { type: 'case.closed', case_id: c.id, outcome: c.outcome })
  releaseCase(caseId)
}

/** A closed case needs no timers or abort controller; evict the oldest closed cases beyond MAX_CASES. */
function releaseCase(caseId: string): void {
  ;(timers.get(caseId) ?? []).forEach(clearTimeout)
  timers.delete(caseId)
  aborts.delete(caseId)
  for (const [id, c] of cases) {
    if (cases.size <= MAX_CASES) break
    if (id !== activeCaseId && c.closed_at) cases.delete(id)
  }
}

async function stageEvidence(c: CaseRecord): Promise<void> {
  const d = c.vault.disputes.find((x) => x.id === c.dispute_id)!
  const evidence = buildEvidencePackage(c.vault, { rationale: c.verdict!.rationale, disputeReason: `${d.network} ${d.reason_code} ${d.reason}` })
  let staged: { stripe_dispute_id?: string; dashboard_url?: string; due_by: string } = { due_by: d.evidence_due_by }
  if (process.env.STRIPE_SECRET_KEY) {
    emit(c, { type: 'agent.status', case_id: c.id, agent: 'critic', status: 'tool', detail: 'stripe: create test dispute + stage evidence (submit=false)' })
    try {
      const s = await stageOnStripe(d.amount, c.order_id, evidence)
      staged = { ...s, due_by: d.evidence_due_by }
    } catch (err) {
      console.warn('[warroom] Stripe staging failed, keeping local package:', (err as Error).message)
    }
  }
  c.stripe = { ...staged, evidence }
  emit(c, { type: 'stripe.evidence_staged', case_id: c.id, dispute_id: c.dispute_id!, stripe_dispute_id: staged.stripe_dispute_id, due_by: staged.due_by, submitted: false, evidence, dashboard_url: staged.dashboard_url })
}

/** The merchant approves the staged package: submit it to Stripe and tell the exhibit. */
export async function submitCase(caseId: string): Promise<{ status: string }> {
  const c = cases.get(caseId)
  if (!c) throw new Error('case_not_found')
  if (!c.stripe?.stripe_dispute_id) throw new Error('nothing_staged_on_stripe')
  if (c.stripe.submitted) return { status: c.stripe.submitted.status }
  const inflight = submitting.get(caseId)
  if (inflight) return inflight
  const stripe = c.stripe
  const run = (async () => {
    // Test mode: a representment we chose to fight resolves as won, so the demo shows the payoff.
    const result = await submitOnStripe(stripe.stripe_dispute_id!, { testOutcome: c.routing?.decision === 'representment' ? 'win' : undefined })
    stripe.submitted = { at: new Date().toISOString(), status: result.status }
    c.outcome = `submitted to Stripe (${result.status})`
    emit(c, { type: 'stripe.submitted', case_id: c.id, dispute_id: c.dispute_id!, stripe_dispute_id: result.id, status: result.status, submitted_at: stripe.submitted.at, dashboard_url: stripe.dashboard_url })
    return { status: result.status }
  })()
  submitting.set(caseId, run)
  try {
    return await run
  } finally {
    submitting.delete(caseId)
  }
}
