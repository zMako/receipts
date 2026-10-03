/**
 * Light-theme palette for the exhibit. The contract keeps its own colours (mirrored in contract.ts and
 * asserted by the test); the exhibit maps everything onto this restrained, product-grade palette.
 */
import type { AgentName } from './contract'

export const UI = {
  page: '#F6F7F9',
  card: '#FFFFFF',
  border: '#E6E8EC',
  text: '#0F172A',
  muted: '#64748B',
  neutralNode: '#CBD5E1',
  edge: '#CBD5E1',
} as const

export const ACCENT = {
  human: '#3B82F6',
  signed: '#10B981',
  'undeclared-suspected': '#F59E0B',
  declared: '#A855F7',
  flagged: '#EF4444',
  cluster: '#EC4899',
} as const

/** Display colours for agents on a white background (darker siblings of the contract hues). */
export const AGENT_COLOR: Record<AgentName, string> = {
  history: '#0EA5E9',
  logistics: '#D97706',
  identity: '#7C3AED',
  forensics: '#DB2777',
  critic: '#059669',
}

export const SEVERITY = {
  critical: { color: '#EF4444', bg: '#FEF2F2', fg: '#B91C1C', label: 'Critical' },
  suspicious: { color: '#F59E0B', bg: '#FFFBEB', fg: '#B45309', label: 'Suspicious' },
  exculpatory: { color: '#10B981', bg: '#ECFDF5', fg: '#047857', label: 'Exculpatory' },
  info: { color: '#94A3B8', bg: '#F1F5F9', fg: '#475569', label: 'Info' },
} as const

export type SeverityKey = keyof typeof SEVERITY

export function severityOf(s: unknown): (typeof SEVERITY)[SeverityKey] {
  return SEVERITY[(typeof s === 'string' && s in SEVERITY ? s : 'info') as SeverityKey]
}

export const POPULATION = {
  human: { color: ACCENT.human, label: 'Human' },
  signed: { color: ACCENT.signed, label: 'Signed agent' },
  'undeclared-suspected': { color: ACCENT['undeclared-suspected'], label: 'Undeclared agent' },
  declared: { color: ACCENT.declared, label: 'Declared agent' },
  cluster: { color: ACCENT.cluster, label: 'Shared sandbox' },
} as const

export function populationOf(p: unknown): { color: string; label: string } {
  if (typeof p === 'string' && p in POPULATION) return POPULATION[p as keyof typeof POPULATION]
  return { color: UI.neutralNode, label: typeof p === 'string' && p ? p : 'Unknown' }
}

/** Verdict tiers rendered as a tinted card, never a coloured left border. */
export const TIER_TINT: Record<string, { bg: string; fg: string; border: string }> = {
  decline: { bg: '#FEF2F2', fg: '#B91C1C', border: '#FECACA' },
  require_verification: { bg: '#FFFBEB', fg: '#B45309', border: '#FDE68A' },
  refund_on_inspection: { bg: '#EFF6FF', fg: '#1D4ED8', border: '#BFDBFE' },
  exchange_first: { bg: '#EFF6FF', fg: '#1D4ED8', border: '#BFDBFE' },
  instant_refund: { bg: '#ECFDF5', fg: '#047857', border: '#A7F3D0' },
}

export const ROUTING_TINT: Record<string, { bg: string; fg: string }> = {
  representment: { bg: '#EFF6FF', fg: '#1D4ED8' },
  refund_and_close: { bg: '#ECFDF5', fg: '#047857' },
  accept_loss: { bg: '#F1F5F9', fg: '#475569' },
}
