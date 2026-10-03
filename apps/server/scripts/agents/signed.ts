/**
 * "cartwright": a signed shopper agent. Signs POST /api/checkout per Web Bot Auth with tag agent-payer-auth,
 * then replays two negative cases: a tampered signature and a reused nonce.
 *   RECEIPTS_URL=http://localhost:8790 npx tsx scripts/agents/signed.ts
 */
import { createHash } from 'node:crypto'
import { createSignature, type RequestDescriptor } from 'http-message-sig'
import { generateNonce } from 'web-bot-auth'
import { signerFromJWK } from 'web-bot-auth/crypto'
import { ensureAgentKey } from '../../src/verify/keys.js'
import { BASE, CART, assertOrExit, postCheckout, printResult, summarize, type CheckoutResponse, type ClientResult } from './common.js'

export const AGENT_NAME = 'cartwright'
export const AGENT_URI = `${BASE}/agents/${AGENT_NAME}`
export const TAG = 'agent-payer-auth'

export async function signedHeaders(opts: { nonce?: string; tag?: string; created?: number; ttl?: number; body?: unknown; bindBody?: boolean } = {}): Promise<Record<string, string>> {
  const key = await ensureAgentKey(AGENT_NAME)
  const signer = await signerFromJWK(key.private_jwk)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': `Agent/${AGENT_NAME} (+${AGENT_URI})`,
    'accept-language': 'en-US,en;q=0.9',
    'signature-agent': `"${AGENT_URI}"`,
    'x-receipts-telemetry': JSON.stringify({ hover_events: 0, scroll_events: 0, duration_s: 4, path: 'straight', checkout_ms: 900, pages: 2 }),
  }
  const bindBody = opts.bindBody ?? true
  if (bindBody) headers['content-digest'] = `sha-256=:${createHash('sha256').update(JSON.stringify(opts.body ?? CART)).digest('base64')}:`
  const descriptor: RequestDescriptor = { kind: 'request', method: 'POST', targetUri: `${BASE}/api/checkout`, fields: Object.entries(headers).map(([name, value]) => ({ name, value })) }
  const created = opts.created ?? Math.floor(Date.now() / 1000)
  const fields = await createSignature(descriptor, {
    label: 'sig1',
    components: bindBody ? ['@authority', '@method', '@path', 'signature-agent', 'content-digest'] : ['@authority', '@method', '@path', 'signature-agent'],
    parameters: { created, expires: created + (opts.ttl ?? 300), nonce: opts.nonce ?? generateNonce(), keyid: signer.keyid, alg: 'ed25519', tag: opts.tag ?? TAG },
    signer,
  })
  headers['signature-input'] = fields.signatureInput
  headers['signature'] = fields.signature
  return headers
}

/** Flip one byte in the signature bytes; headers otherwise identical. */
export function tamper(headers: Record<string, string>): Record<string, string> {
  const sig = headers['signature']!
  const m = /^(.*=:)([A-Za-z0-9+/=]+)(:.*)$/.exec(sig)
  if (!m) throw new Error('unexpected Signature format')
  const b64 = m[2]!
  const i = Math.floor(b64.length / 2)
  const swapped = b64[i] === 'A' ? 'B' : 'A'
  return { ...headers, signature: `${m[1]}${b64.slice(0, i)}${swapped}${b64.slice(i + 1)}${m[3]}` }
}

export async function run(): Promise<{ results: ClientResult[]; responses: CheckoutResponse[] }> {
  const key = await ensureAgentKey(AGENT_NAME)
  console.log(`cartwright keyid ${key.kid} (directory ${AGENT_URI}/.well-known/http-message-signatures-directory)`)

  const good = await signedHeaders()
  const r1 = await postCheckout(good, CART)
  printResult('cartwright: signed checkout', r1)
  assertOrExit(r1.population === 'signed' && r1.signature?.verified === true, 'signed -> population signed, verified true')

  const unbound = await postCheckout(await signedHeaders({ bindBody: false }), CART)
  printResult('cartwright: signed, body not bound', unbound)
  assertOrExit(unbound.signature?.verified === false && unbound.signature?.reason === 'body_not_bound', 'unbound -> verified false (body_not_bound)')

  const swapped = await postCheckout(await signedHeaders({ body: CART }), { ...(CART as object), lines: [{ sku: 'HP-PRK-SUMMIT', qty: 3 }] })
  printResult('cartwright: signature for a different cart', swapped)
  assertOrExit(swapped.signature?.verified === false && swapped.signature?.reason === 'content_digest_mismatch', 'swapped cart -> verified false (content_digest_mismatch)')

  const r2 = await postCheckout(tamper(await signedHeaders()), CART)
  printResult('cartwright: tampered signature', r2)
  assertOrExit(r2.signature?.verified === false && r2.population !== 'signed', `tampered -> verified false (reason ${r2.signature?.reason})`)

  const r3 = await postCheckout(good, CART)
  printResult('cartwright: replayed nonce', r3)
  assertOrExit(r3.signature?.verified === false && r3.signature?.reason === 'nonce_replayed', `replayed -> verified false, reason nonce_replayed (got ${r3.signature?.reason})`)

  return {
    responses: [r1, r2, r3],
    results: [
      summarize('cartwright signed', r1, (r) => r.population === 'signed' && r.signature?.verified === true),
      summarize('cartwright tampered', r2, (r) => r.signature?.verified === false),
      summarize('cartwright replayed', r3, (r) => r.signature?.verified === false && r.signature?.reason === 'nonce_replayed'),
    ],
  }
}

if (process.argv[1] && /signed\.ts$/.test(process.argv[1])) {
  run().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
