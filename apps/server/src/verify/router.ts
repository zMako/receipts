/**
 * Verifier HTTP surface. Mount at the app root: `app.use(verifyRouter)` (paths are absolute, including /api/*).
 *   GET  /agents/:name/.well-known/http-message-signatures-directory  JWKS for a locally registered test agent
 *   POST /api/checkout                                                 verify + classify a cart, emit checkout.observed
 *   GET  /api/checkouts                                                recent checkout.observed payloads, newest first
 */
import { Router, type Request } from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { PRODUCTS, type LiveEvent } from '@receipts/seed'
import { jwksFor } from './keys.js'
import { addLocalDirectoryResolver, verifyAgentRequest } from './webBotAuth.js'
import { classifyRequest } from './classifyRequest.js'
import type { AgentIdentityResult } from './types.js'

export type CheckoutObserved = Extract<LiveEvent, { type: 'checkout.observed' }>

/** Full record kept per live checkout: the contract payload plus what the merchant stores in the vault. */
export interface CheckoutRecord extends CheckoutObserved {
  customer_id: string
  placed_at: string
  lines: { sku: string; qty: number; size?: string; color?: string; name?: string; price?: number }[]
  total: number
  identity: AgentIdentityResult
}

export const MAX_RECENT = 500
/** Newest first. */
export const recentCheckouts: CheckoutRecord[] = []

type Broadcaster = (type: string, payload: unknown) => void
let broadcaster: Broadcaster | undefined
/** Wired by index.ts: `setBroadcaster(broadcast)`. Avoids a circular import. */
export function setBroadcaster(fn: Broadcaster): void {
  broadcaster = fn
}

// Agents hosted by this server verify in-process (no DNS, no self-fetch): the Signature-Agent host must be our own host.
addLocalDirectoryResolver((agentUri, req: Request) => {
  const ourHost = (req.get('host') ?? '').toLowerCase()
  if (agentUri.host.toLowerCase() !== ourHost) return undefined
  const m = /^\/agents\/([a-z0-9][a-z0-9-]*)\/?$/.exec(agentUri.pathname)
  return m ? jwksFor(m[1]!) : undefined
})

const router = Router()

router.get('/agents/:name/.well-known/http-message-signatures-directory', (req, res) => {
  const jwks = jwksFor(req.params.name)
  if (!jwks) return res.status(404).json({ error: 'unknown_agent', agent: req.params.name })
  res.setHeader('Cache-Control', 'max-age=86400')
  res.setHeader('Content-Type', 'application/http-message-signatures-directory+json')
  res.send(JSON.stringify(jwks))
})

router.get('/agents/:name', (req, res) => {
  const jwks = jwksFor(req.params.name)
  if (!jwks) return res.status(404).json({ error: 'unknown_agent', agent: req.params.name })
  res.json({ agent: req.params.name, directory: `${req.protocol}://${req.get('host')}/agents/${req.params.name}/.well-known/http-message-signatures-directory`, keys: jwks.keys.length })
})

const CheckoutBody = z.object({
  customer_id: z.string().min(1).max(64),
  lines: z.array(z.object({ sku: z.string().min(1), qty: z.number().int().min(1).max(50), size: z.string().optional(), color: z.string().optional() })).min(1).max(20),
  telemetry: z.unknown().optional(),
  /** Optional merchant-side hint; the vault scores single-use Link cards. */
  payment_kind: z.string().optional(),
})

export function toObserved(orderId: string, id: AgentIdentityResult): CheckoutObserved {
  const ev: CheckoutObserved = { type: 'checkout.observed', order_id: orderId, population: id.population, score: id.score, signals: id.signals }
  if (id.verified || id.reason) {
    ev.signature = { signature_agent: id.signature_agent ?? 'unknown', keyid: id.keyid ?? 'unknown', tag: id.tag ?? 'unknown', verified: id.verified }
    if (id.reason) ev.signature.reason = id.reason
  }
  return ev
}

router.post('/api/checkout', verifyAgentRequest(), (req, res) => {
  const parsed = CheckoutBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues })
  const body = parsed.data
  const identity = req.agentIdentity ?? classifyRequest(req, { customerId: body.customer_id, paymentKind: body.payment_kind })
  const order_id = 'ord_live_' + randomBytes(3).toString('hex')
  const lines = body.lines.map((l) => {
    const p = PRODUCTS.find((x) => x.sku === l.sku)
    return { ...l, name: p?.name, price: p?.price }
  })
  const total = Math.round(lines.reduce((s, l) => s + (l.price ?? 0) * l.qty, 0) * 100) / 100
  const observed = toObserved(order_id, identity)
  const record: CheckoutRecord = { ...observed, customer_id: body.customer_id, placed_at: new Date().toISOString(), lines, total, identity }
  recentCheckouts.unshift(record)
  if (recentCheckouts.length > MAX_RECENT) recentCheckouts.length = MAX_RECENT
  try {
    broadcaster?.('checkout.observed', observed)
  } catch (e) {
    console.error('[verify] broadcast failed', e)
  }
  res.status(201).json({ ...observed, detail: { customer_id: body.customer_id, total, placed_at: record.placed_at, identity } })
})

router.get('/api/checkouts', (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), MAX_RECENT)
  res.json(recentCheckouts.slice(0, limit))
})

export default router
