/**
 * Browser-side view of the live event contract.
 *
 * Types are imported straight from `@receipts/seed` (erased at build time). The runtime constants
 * are mirrored here because the seed package's entry point pulls in `node:fs`, which cannot be
 * bundled for the browser. `state.test.ts` asserts the mirror matches the contract exactly.
 */
import type { AgentName, AgentPopulation } from '@receipts/seed'

export type {
  AgentName,
  AgentPopulation,
  EvidenceFamily,
  EvidenceItem,
  GraphDelta,
  LiveEvent,
  RoutingDecision,
  Severity,
  TimedEvent,
  VerdictTier,
} from '@receipts/seed'

export const AGENT_NAMES: readonly AgentName[] = ['history', 'logistics', 'identity', 'forensics', 'critic']

export const AGENT_META: Record<AgentName, { title: string; color: string; brief: string }> = {
  history: { title: 'History', color: '#7dd3fc', brief: 'Customer order, return and claim history' },
  logistics: { title: 'Logistics', color: '#fbbf24', brief: 'Carrier scans, inbound weight, delivery proof' },
  identity: { title: 'Identity', color: '#c084fc', brief: 'Agent signatures, fingerprints, cross-account linkage' },
  forensics: { title: 'Forensics', color: '#f472b6', brief: 'Claim photos, receipts and claim text' },
  critic: { title: 'Critic', color: '#4ade80', brief: 'Weighs evidence, issues the verdict' },
}

/** HTTP surface the exhibit calls. Mirrors `API` in the contract. */
export const API = {
  graph: '/api/graph',
  stats: '/api/stats',
  heroes: '/api/heroes',
  evidence: (orderId: string) => `/api/orders/${orderId}/evidence`,
  replay: (name: string) => `/api/replay/${name}`,
  openCase: '/api/cases/open',
  submitCase: (caseId: string) => `/api/cases/${caseId}/submit`,
  reset: '/api/reset',
  checkout: '/api/checkout',
  live: '/live',
} as const

/** Order node colours by population; 'cluster' is the shared Muse sandbox device. */
export const POPULATION_COLOR: Record<AgentPopulation | 'cluster', string> = {
  human: '#7dd3fc',
  signed: '#4ade80',
  'undeclared-suspected': '#fb923c',
  declared: '#fbbf24',
  cluster: '#e879f9',
}

export const POPULATION_LABEL: Record<AgentPopulation | 'cluster', string> = {
  human: 'Human',
  signed: 'Signed agent',
  'undeclared-suspected': 'Undeclared agent',
  declared: 'Declared agent',
  cluster: 'Shared sandbox',
}

export const SEVERITY_COLOR = {
  info: '#94a3b8',
  suspicious: '#fb923c',
  critical: '#f87171',
  exculpatory: '#4ade80',
} as const
