/**
 * Runs the signed, muse and human clients in order against RECEIPTS_URL and prints a table.
 *   RECEIPTS_URL=http://localhost:8790 npx tsx scripts/agents/all.ts
 */
import { BASE, type ClientResult } from './common.js'
import { run as runSigned } from './signed.js'
import { run as runMuse } from './muse.js'
import { run as runHuman } from './human.js'

async function main(): Promise<void> {
  console.log(`Receipts verifier demo against ${BASE}`)
  const results: ClientResult[] = []
  results.push(...(await runSigned()).results)
  results.push(...(await runMuse()).results)
  results.push(...(await runHuman()).results)
  console.log('\n== summary ==')
  console.table(results.map((r) => ({ client: r.client, order: r.order_id, population: r.population, score: r.score, verified: r.verified === null ? '-' : String(r.verified), reason: r.reason ?? '-', top_signals: r.top_signals, ok: r.ok ? 'PASS' : 'FAIL' })))
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.error(`${failed.length} check(s) failed`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
