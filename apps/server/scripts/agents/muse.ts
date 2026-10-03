/**
 * An undeclared, Muse-like shopper: identical Linux Chrome sandbox image, cloud egress, zero pointer telemetry,
 * straight-line 40 s session, 3 s checkout. No signature, no Agent/ UA. Expect undeclared-suspected.
 */
import { MUSE_UA } from '../../src/verify/classifyRequest.js'
import { CART, assertOrExit, postCheckout, printResult, summarize, type CheckoutResponse, type ClientResult } from './common.js'

export function museHeaders(): Record<string, string> {
  return {
    'user-agent': MUSE_UA,
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-platform': '"Linux"',
    'sec-ch-ua-mobile': '?0',
    accept: 'application/json',
    // Cloudflare egress, dev-only hint since the test server has no IP-to-ASN lookup.
    'x-asn': '13335',
    'x-receipts-telemetry': JSON.stringify({ hover_events: 0, scroll_events: 0, duration_s: 40, path: 'straight', checkout_ms: 3000, pages: 2 }),
    // No Accept-Language on purpose: headless sandboxes often omit it.
  }
}

export async function run(): Promise<{ results: ClientResult[]; responses: CheckoutResponse[] }> {
  const r = await postCheckout(museHeaders(), { ...CART, customer_id: 'cus_live_muse', payment_kind: 'link_single_use' })
  printResult('muse-like undeclared agent', r)
  assertOrExit(r.population === 'undeclared-suspected' && r.score >= 0.5, `muse -> undeclared-suspected with score >= 0.5 (got ${r.population} ${r.score})`)
  return { responses: [r], results: [summarize('muse undeclared', r, (x) => x.population === 'undeclared-suspected' && x.score >= 0.5)] }
}

if (process.argv[1] && /muse\.ts$/.test(process.argv[1])) {
  run().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
