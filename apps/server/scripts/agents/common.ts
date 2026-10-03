import type { AgentPopulation } from '@receipts/seed'

export const BASE = (process.env.RECEIPTS_URL ?? 'http://localhost:8787').replace(/\/+$/, '')

export const CART = {
  customer_id: 'cus_live_demo',
  lines: [
    { sku: 'HP-PRK-SUMMIT', qty: 1, size: 'M', color: 'Spruce' },
    { sku: 'HP-BASE-MERINO', qty: 2, size: 'M' },
  ],
}

export interface CheckoutResponse {
  type: 'checkout.observed'
  order_id: string
  population: AgentPopulation
  score: number
  signals: { signal: string; detail: string; weight: number }[]
  signature?: { signature_agent: string; keyid: string; tag: string; verified: boolean; reason?: string }
  detail?: { customer_id: string; total: number; placed_at: string; identity: Record<string, unknown> }
  error?: string
}

export async function postCheckout(headers: Record<string, string>, body: unknown = CART): Promise<CheckoutResponse> {
  const res = await fetch(`${BASE}/api/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const json = (await res.json()) as CheckoutResponse
  if (!res.ok) throw new Error(`POST /api/checkout -> ${res.status} ${JSON.stringify(json)}`)
  return json
}

export interface ClientResult {
  client: string
  order_id: string
  population: AgentPopulation
  score: number
  verified: boolean | null
  reason: string | null
  top_signals: string
  ok: boolean
}

export function summarize(client: string, r: CheckoutResponse, expect: (r: CheckoutResponse) => boolean): ClientResult {
  const top = [...r.signals].sort((a, b) => b.weight - a.weight).slice(0, 3).map((s) => `${s.signal}(${s.weight})`).join(' ')
  return { client, order_id: r.order_id, population: r.population, score: r.score, verified: r.signature ? r.signature.verified : null, reason: r.signature?.reason ?? null, top_signals: top, ok: expect(r) }
}

export function printResult(title: string, r: CheckoutResponse): void {
  console.log(`\n== ${title} ==`)
  console.log(`order_id   ${r.order_id}`)
  console.log(`population ${r.population}  score ${r.score}`)
  if (r.signature) console.log(`signature  verified=${r.signature.verified}${r.signature.reason ? ` reason=${r.signature.reason}` : ''}  agent=${r.signature.signature_agent}  keyid=${r.signature.keyid.slice(0, 12)}…  tag=${r.signature.tag}`)
  else console.log('signature  (none)')
  for (const s of r.signals) console.log(`  - ${s.signal} [${s.weight}] ${s.detail}`)
}

export function assertOrExit(cond: boolean, msg: string): void {
  if (cond) console.log(`PASS ${msg}`)
  else {
    console.log(`FAIL ${msg}`)
    process.exitCode = 1
  }
}
