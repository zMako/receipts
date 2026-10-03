/**
 * Live event contract between the server (war room, verifier, router) and the exhibit.
 * Every message on the WebSocket at /live is `{ type, payload, at }` where `payload` is one of these.
 * The same objects are returned by GET /api/replay/:name as a timed array for offline playback.
 */
import type { AgentPopulation } from './types.js'

export const AGENT_NAMES = ['history', 'logistics', 'identity', 'forensics', 'critic'] as const
export type AgentName = (typeof AGENT_NAMES)[number]

export const AGENT_META: Record<AgentName, { title: string; color: string; brief: string }> = {
  history: { title: 'History', color: '#7dd3fc', brief: 'Customer order, return and claim history' },
  logistics: { title: 'Logistics', color: '#fbbf24', brief: 'Carrier scans, inbound weight, delivery proof' },
  identity: { title: 'Identity', color: '#c084fc', brief: 'Agent signatures, fingerprints, cross-account linkage' },
  forensics: { title: 'Forensics', color: '#f472b6', brief: 'Claim photos, receipts and claim text' },
  critic: { title: 'Critic', color: '#4ade80', brief: 'Weighs evidence, issues the verdict' },
}

export type EvidenceFamily = 'customer_history' | 'order_shape' | 'identity_linkage' | 'logistics' | 'claim_artifacts' | 'velocity' | 'double_dip' | 'agent_identity' | 'delivery'
export type Severity = 'info' | 'suspicious' | 'critical' | 'exculpatory'
export type VerdictTier = 'instant_refund' | 'exchange_first' | 'refund_on_inspection' | 'require_verification' | 'decline'
export type RoutingDecision = 'refund_and_close' | 'representment' | 'accept_loss'

export interface GraphDelta {
  nodes?: { id: string; type: 'customer' | 'order' | 'device' | 'address' | 'payment' | 'return' | 'dispute' | 'evidence'; label: string; population?: string; flags?: string[] }[]
  edges?: { source: string; target: string; type: string }[]
}

export interface EvidenceItem {
  id: string
  family: EvidenceFamily
  label: string
  detail: string
  severity: Severity
  /** -1..1; negative is exculpatory, positive points at abuse. */
  weight: number
  /** Graph node ids this evidence touches; the exhibit highlights them. */
  node_ids: string[]
  graph?: GraphDelta
}

export type LiveEvent =
  | { type: 'hello'; server_time: string; active_case: string | null; merchant: string }
  | { type: 'checkout.observed'; order_id: string; population: AgentPopulation; score: number; signals: { signal: string; detail: string; weight: number }[]; signature?: { signature_agent: string; keyid: string; tag: string; verified: boolean; reason?: string } }
  | { type: 'case.opened'; case_id: string; kind: 'return' | 'dispute'; order_id: string; customer_id: string; customer_name: string; title: string; summary: string; amount: number; population: AgentPopulation; flags: string[]; room: { id: string; title: string } | null; due_by?: string }
  | { type: 'agent.joined'; case_id: string; agent: AgentName; handle: string }
  | { type: 'agent.status'; case_id: string; agent: AgentName; status: 'thinking' | 'tool' | 'posting' | 'done' | 'error'; detail?: string }
  | { type: 'agent.message'; case_id: string; agent: AgentName; text: string; mentions: AgentName[]; band_message_id?: string }
  | { type: 'evidence.attached'; case_id: string; agent: AgentName; evidence: EvidenceItem }
  | { type: 'verdict'; case_id: string; tier: VerdictTier; confidence: number; score: number; rationale: string; policy_citation?: string; evidence_ids: string[] }
  | { type: 'dispute.routing'; case_id: string; dispute_id: string; decision: RoutingDecision; rationale: string; vamp: { ratio_before: number; ratio_after: number; threshold: number; headroom_items: number }; expected_recovery: number }
  | { type: 'stripe.evidence_staged'; case_id: string; dispute_id: string; stripe_dispute_id?: string; due_by: string; submitted: false; evidence: Record<string, string>; dashboard_url?: string }
  | { type: 'stripe.submitted'; case_id: string; dispute_id: string; stripe_dispute_id: string; status: string; submitted_at: string; dashboard_url?: string }
  | { type: 'case.closed'; case_id: string; outcome: string }
  | { type: 'reset' }

export interface TimedEvent {
  /** Milliseconds after playback start. */
  at_ms: number
  event: LiveEvent
}

/** HTTP surface the exhibit may call. Implemented by apps/server. */
export const API = {
  graph: '/api/graph',
  stats: '/api/stats',
  heroes: '/api/heroes',
  evidence: (orderId: string) => `/api/orders/${orderId}/evidence`,
  replay: (name: string) => `/api/replay/${name}`,
  /** POST { dispute_id } or { return_id }; returns { case_id }. Starts a live war room. */
  openCase: '/api/cases/open',
  /** POST; submits the staged Stripe evidence for the case (merchant approval). Returns { status }. */
  submitCase: (caseId: string) => `/api/cases/${caseId}/submit`,
  /** POST; clears live state and broadcasts { type: 'reset' }. */
  reset: '/api/reset',
  /** POST a cart with optional signature headers; returns checkout.observed payload. */
  checkout: '/api/checkout',
  live: '/live',
} as const
