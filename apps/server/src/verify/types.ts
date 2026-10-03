import type { AgentPopulation, PopulationSignal } from '@receipts/seed'

/** TS's built-in JsonWebKey has no kid/use; the directory publishes both. */
export type Jwk = JsonWebKey & { kid?: string; use?: string }

export const WEB_BOT_AUTH_TAGS = ['web-bot-auth', 'agent-browser-auth', 'agent-payer-auth'] as const
export type WebBotAuthTag = (typeof WEB_BOT_AUTH_TAGS)[number]

/** What our checkout page sends in the `x-receipts-telemetry` header (or `body.telemetry`). */
export interface CheckoutTelemetry {
  hover_events: number
  scroll_events: number
  duration_s: number
  path: 'browse' | 'straight'
  checkout_ms: number
  pages?: number
}

/** Result of the verifier middleware, attached as `req.agentIdentity`. */
export interface AgentIdentityResult {
  population: AgentPopulation
  /** 0..1, same scale as `EvidenceVault.population_score`. */
  score: number
  signals: PopulationSignal[]
  /** True only when an HTTP Message Signature was present and verified end to end. */
  verified: boolean
  /** Present whenever a signature was attempted, valid or not. */
  signature_agent?: string
  keyid?: string
  tag?: string
  created?: number
  expires?: number
  nonce?: string
  alg?: string
  /** Covered components of the verified signature, e.g. ["@authority", "@method", "@path", "signature-agent"]. */
  covered?: string[]
  /** Why a present signature failed. Absent when verified or when no signature was sent. */
  reason?: string
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agentIdentity?: AgentIdentityResult
    }
  }
}
