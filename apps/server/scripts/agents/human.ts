/**
 * A normal shopper in a desktop browser with realistic pointer and timing telemetry. Expect human.
 */
import { CART, assertOrExit, postCheckout, printResult, summarize, type CheckoutResponse, type ClientResult } from './common.js'

export function humanHeaders(): Record<string, string> {
  return {
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-platform': '"macOS"',
    'sec-ch-ua-mobile': '?0',
    'accept-language': 'en-US,en;q=0.9,pl;q=0.8',
    accept: 'application/json',
    referer: 'https://shop.harborandpine.example/checkout',
    'x-receipts-telemetry': JSON.stringify({ hover_events: 143, scroll_events: 38, duration_s: 412, path: 'browse', checkout_ms: 48_000, pages: 7 }),
  }
}

export async function run(): Promise<{ results: ClientResult[]; responses: CheckoutResponse[] }> {
  const r = await postCheckout(humanHeaders(), { ...CART, customer_id: 'cus_live_human' })
  printResult('human shopper', r)
  assertOrExit(r.population === 'human', `human -> population human (got ${r.population} ${r.score})`)
  return { responses: [r], results: [summarize('human browser', r, (x) => x.population === 'human')] }
}

if (process.argv[1] && /human\.ts$/.test(process.argv[1])) {
  run().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
