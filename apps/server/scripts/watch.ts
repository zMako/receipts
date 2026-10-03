import '../src/env.js'
import WebSocket from 'ws'

const base = process.env.RECEIPTS_URL ?? 'http://localhost:8787'
const ws = new WebSocket(base.replace(/^http/, 'ws') + '/live')
const started = Date.now()
let caseId: string | undefined
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`
ws.on('open', async () => {
  console.log(t(), 'connected')
  const target = process.argv[2] ?? 'dp_doubledip'
  const body = target.startsWith('dp_') ? { dispute_id: target } : { return_id: target }
  const res = await fetch(`${base}/api/cases/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const body2 = await res.json()
  caseId = body2.case_id
  console.log(t(), 'open ->', res.status, caseId)
})
ws.on('message', (raw) => {
  const { payload: p } = JSON.parse(String(raw))
  if (p.case_id && caseId && p.case_id !== caseId) return
  if (p.case_id && !caseId) return
  const line =
    p.type === 'evidence.attached' ? `${p.agent} attached [${p.evidence.severity} ${p.evidence.weight}] ${p.evidence.label}`
    : p.type === 'agent.message' ? `${p.agent} says: ${p.text.slice(0, 160)}${p.band_message_id ? ' [band]' : ''}`
    : p.type === 'agent.status' ? `${p.agent} ${p.status}${p.detail ? ' ' + p.detail : ''}`
    : p.type === 'verdict' ? `VERDICT ${p.tier} conf=${p.confidence} score=${p.score}: ${p.rationale}`
    : p.type === 'dispute.routing' ? `ROUTING ${p.decision} vamp ${p.vamp.ratio_before}->${p.vamp.ratio_after} recovery $${p.expected_recovery}: ${p.rationale}`
    : p.type === 'stripe.evidence_staged' ? `STRIPE staged ${p.stripe_dispute_id ?? '(local)'} ${p.dashboard_url ?? ''} fields=${Object.keys(p.evidence).length}`
    : p.type === 'case.closed' ? `CLOSED ${p.outcome}`
    : p.type === 'case.opened' ? `OPENED ${p.title} room=${p.room?.title ?? 'none'}`
    : p.type
  console.log(t(), line)
  if (p.type === 'case.closed') { ws.close(); process.exit(0) }
})
setTimeout(() => { console.log('watch timeout'); process.exit(1) }, 240_000)
