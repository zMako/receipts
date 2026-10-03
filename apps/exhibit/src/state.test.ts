/**
 * Reducer test. Run with: npx tsx src/state.test.ts (from apps/exhibit).
 * Feeds the full double-dip replay through the pure reducer and checks the final state, then
 * fires one synthetic event of every type in the contract to make sure nothing throws.
 */
import assert from 'node:assert/strict'
import { AGENT_META as CONTRACT_AGENT_META, AGENT_NAMES as CONTRACT_AGENT_NAMES, API as CONTRACT_API, doubleDipReplay, type LiveEvent } from '@receipts/seed'
import { AGENT_META, AGENT_NAMES, API } from './contract'
import { parseFrame } from './feed'
import { applyEvent, hasLiveCase, initialState, isForeignCaseEvent, seedGraph, tick, type State } from './state'

let passed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (err) {
    console.log(`FAIL ${name}`)
    console.log(err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
}

const seed = {
  nodes: [
    { id: 'cus_doubledip', type: 'customer', label: 'Theo Walsh' },
    { id: 'ord_doubledip', type: 'order', label: 'ord_doubledip', population: 'undeclared-suspected', flags: ['double_dip'] },
    { id: 'dev_77d991f2', type: 'device', label: 'muse-sandbox', population: 'cluster' },
    { id: 'dev_8e4b0b4d', type: 'device', label: 'muse-sandbox', population: 'cluster' },
    { id: 'ret_doubledip', type: 'return', label: 'return: not as described' },
    { id: 'dp_doubledip', type: 'dispute', label: 'visa 10.4 fraudulent' },
    { id: 'ord_other', type: 'order', label: 'ord_other', population: 'human' },
  ],
  edges: [
    { source: 'cus_doubledip', target: 'ord_doubledip', type: 'placed' },
    { source: 'ord_doubledip', target: 'dev_77d991f2', type: 'used_device' },
    { source: 'ord_doubledip', target: 'ret_doubledip', type: 'returned' },
    { source: 'ord_doubledip', target: 'dp_doubledip', type: 'disputed' },
    { source: 'ord_doubledip', target: 'ghost', type: 'disputed' },
  ],
}

check('contract mirror matches @receipts/seed', () => {
  assert.deepEqual(AGENT_META, CONTRACT_AGENT_META)
  assert.deepEqual([...AGENT_NAMES], [...CONTRACT_AGENT_NAMES])
  const keys = Object.keys(CONTRACT_API) as (keyof typeof CONTRACT_API)[]
  assert.deepEqual(Object.keys(API), keys)
  for (const k of keys) {
    const a = API[k] as unknown
    const b = CONTRACT_API[k] as unknown
    if (typeof a === 'function' && typeof b === 'function') assert.equal((a as (x: string) => string)('x'), (b as (x: string) => string)('x'))
    else assert.equal(a, b)
  }
})

const replay = doubleDipReplay()
let state: State = seedGraph(initialState(), seed)

check('seed graph loads and drops dangling edges', () => {
  assert.equal(state.graph.nodes.length, 7)
  assert.equal(state.graph.edges.length, 4)
  assert.ok(state.graph.byId['ord_doubledip'])
})

check('replay applies without throwing', () => {
  for (const { event } of replay) {
    state = applyEvent(state, event)
    // Simulate frames between events: decay must also never throw.
    state = tick(state, 0.4)
  }
  assert.equal(state.seq, replay.length)
  assert.equal(state.unknownEvents, 0)
})

check('final state: verdict tier decline', () => {
  assert.ok(state.verdict, 'verdict present')
  assert.equal(state.verdict!.tier, 'decline')
  assert.ok(state.verdict!.confidence > 0.9)
  assert.equal(state.verdict!.evidence_ids.length, 6)
})

check('final state: 6 evidence items', () => {
  assert.equal(state.evidence.length, 6)
  assert.deepEqual(
    state.evidence.map((e) => e.id),
    ['ev_fp', 'ev_egress', 'ev_hist', 'ev_delivery', 'ev_refund', 'ev_claim'],
  )
})

check('final state: 5 agents joined', () => {
  const joined = Object.values(state.agents).filter((a) => a.joined)
  assert.equal(joined.length, 5)
  assert.equal(state.agents.identity.evidenceCount, 2)
  assert.equal(state.agents.logistics.evidenceCount, 2)
  assert.equal(state.agents.history.evidenceCount, 1)
  assert.equal(state.agents.forensics.evidenceCount, 1)
  assert.equal(state.agents.critic.evidenceCount, 0)
  for (const a of joined) assert.equal(a.status, 'done')
})

check('final state: stripe package staged, not submitted', () => {
  assert.ok(state.stripe)
  assert.equal(state.stripe!.submitted, false)
  assert.equal(state.stripe!.dispute_id, 'dp_doubledip')
  assert.equal(state.stripe!.due_by, '2026-10-08T16:00:00.000Z')
  assert.ok(Object.keys(state.stripe!.evidence).length >= 5)
})

check('final state: routing and case', () => {
  assert.ok(state.routing)
  assert.equal(state.routing!.decision, 'representment')
  assert.equal(state.routing!.expected_recovery, 289)
  assert.ok(state.case)
  assert.equal(state.case!.closed, true)
  assert.equal(state.case!.order_id, 'ord_doubledip')
  assert.equal(state.merchant, 'Harbor & Pine Outfitters')
  assert.equal(hasLiveCase(state), false)
})

check('graph delta added dev_muse and its edge', () => {
  assert.ok(state.graph.byId['dev_muse'])
  assert.equal(state.graph.byId['dev_muse'].population, 'cluster')
  assert.ok(state.graph.edges.some((e) => e.source === 'ord_doubledip' && e.target === 'dev_muse' && e.type === 'used_device'))
  assert.equal(state.graph.nodes.length, 8)
  // seed cluster devices lit by the ring reveal
  assert.ok(state.highlightFloor['ord_doubledip'] > 0)
})

check('transcript ordered and complete', () => {
  const kinds = state.transcript.map((l) => l.kind)
  assert.equal(state.transcript.filter((l) => l.kind === 'message').length, 6)
  assert.ok(kinds[0] === 'system')
  const ids = state.transcript.map((l) => l.id)
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1])
})

check('highlights decay towards floor and never below', () => {
  let s = applyEvent(state, { type: 'evidence.attached', case_id: state.case!.case_id, agent: 'history', evidence: { id: 'ev_x', family: 'velocity', label: 'x', detail: 'x', severity: 'critical', weight: 0.1, node_ids: ['ord_other'] } })
  assert.equal(s.highlights['ord_other'], 1)
  for (let i = 0; i < 100; i++) s = tick(s, 0.5)
  assert.ok(s.highlights['ord_other'] <= 0.3 && s.highlights['ord_other'] >= 0.27, `floor hold: ${s.highlights['ord_other']}`)
  assert.ok(s.highlights['ord_doubledip'] >= 0.54)
  // ids with no floor are pruned once dim
  let t = seedGraph(initialState(), seed)
  t = applyEvent(t, { type: 'checkout.observed', order_id: 'ord_other', population: 'signed', score: 1, signals: [] })
  assert.equal(t.highlights['ord_other'], 1)
  assert.equal(t.graph.byId['ord_other'].population, 'signed')
  for (let i = 0; i < 100; i++) t = tick(t, 0.5)
  assert.equal(t.highlights['ord_other'], undefined)
  assert.equal(tick(t, 1), t, 'no-op tick returns same object')
})

check('every event type in the contract is handled', () => {
  const samples: LiveEvent[] = [
    { type: 'hello', server_time: '2026-10-03T16:00:00.000Z', active_case: 'case_x', merchant: 'M' },
    { type: 'checkout.observed', order_id: 'ord_new', population: 'signed', score: 1, signals: [{ signal: 'web_bot_auth_verified', detail: 'ok', weight: 1 }], signature: { signature_agent: 'agent.example', keyid: 'k', tag: 'web-bot-auth', verified: true } },
    { type: 'case.opened', case_id: 'case_x', kind: 'return', order_id: 'ord_missing', customer_id: 'cus_missing', customer_name: 'Nobody', title: 'Return', summary: 's', amount: 10, population: 'human', flags: [], room: null },
    { type: 'agent.joined', case_id: 'case_x', agent: 'history', handle: 'h' },
    { type: 'agent.status', case_id: 'case_x', agent: 'history', status: 'tool', detail: 't()' },
    { type: 'agent.status', case_id: 'case_x', agent: 'history', status: 'posting' },
    { type: 'agent.status', case_id: 'case_x', agent: 'history', status: 'error', detail: 'boom' },
    { type: 'agent.message', case_id: 'case_x', agent: 'history', text: 'hi @critic', mentions: ['critic'], band_message_id: 'b1' },
    { type: 'evidence.attached', case_id: 'case_x', agent: 'forensics', evidence: { id: 'ev_1', family: 'claim_artifacts', label: 'l', detail: 'd', severity: 'info', weight: 0, node_ids: ['nope', 'ord_missing'], graph: { nodes: [{ id: 'ev_1', type: 'evidence', label: 'photo' }], edges: [{ source: 'ord_missing', target: 'ev_1', type: 'evidence' }, { source: 'ev_1', target: 'ghost', type: 'x' }] } } },
    { type: 'verdict', case_id: 'case_x', tier: 'instant_refund', confidence: 0.5, score: 0.1, rationale: 'r', evidence_ids: ['ev_1', 'ev_nope'] },
    { type: 'dispute.routing', case_id: 'case_x', dispute_id: 'dp_x', decision: 'refund_and_close', rationale: 'r', vamp: { ratio_before: 0.01, ratio_after: 0.01, threshold: 0.015, headroom_items: 3 }, expected_recovery: 0 },
    { type: 'stripe.evidence_staged', case_id: 'case_x', dispute_id: 'dp_x', stripe_dispute_id: 'dp_1', due_by: '2026-10-09T00:00:00.000Z', submitted: false, evidence: { a: 'b' }, dashboard_url: 'https://dashboard.stripe.com/test' },
    { type: 'case.closed', case_id: 'case_x', outcome: 'closed' },
    { type: 'stripe.submitted', case_id: 'case_x', dispute_id: 'dp_x', stripe_dispute_id: 'dp_1', status: 'under_review', submitted_at: '2026-10-03T22:00:00.000Z' },
    { type: 'reset' },
  ]
  const types = new Set(samples.map((e) => e.type))
  const contractTypes = ['hello', 'checkout.observed', 'case.opened', 'agent.joined', 'agent.status', 'agent.message', 'evidence.attached', 'verdict', 'dispute.routing', 'stripe.evidence_staged', 'stripe.submitted', 'case.closed', 'reset']
  for (const t of contractTypes) assert.ok(types.has(t as LiveEvent['type']), `sample for ${t}`)

  let s = seedGraph(initialState(), seed)
  for (const e of samples) {
    s = applyEvent(s, e)
    assert.equal(s.unknownEvents, 0, `handled ${e.type}`)
  }
  assert.equal(s.seq, samples.length)
  // reset wiped the case but kept the seed graph and merchant
  assert.equal(s.case, null)
  assert.equal(s.evidence.length, 0)
  // 7 seed nodes plus the ord_new checkout order, which is a real order and survives the reset.
  assert.equal(s.graph.nodes.length, 8)
  assert.ok(s.graph.byId['ord_new'])
  assert.equal(s.merchant, 'M')

  // mid-stream checks on a copy
  let m = seedGraph(initialState(), seed)
  for (const e of samples.slice(0, 9)) m = applyEvent(m, e)
  assert.ok(m.graph.byId['ord_missing'], 'case.opened synthesises a missing order node')
  assert.ok(m.graph.byId['cus_missing'], 'case.opened synthesises a missing customer node')
  assert.ok(m.graph.byId['ev_1'], 'evidence delta node added')
  assert.ok(m.graph.edges.some((e) => e.source === 'ord_missing' && e.target === 'ev_1'))
  assert.ok(!m.graph.edges.some((e) => e.target === 'ghost'), 'dangling delta edge dropped')
  assert.equal(m.highlights['nope'], undefined, 'missing node ids are ignored')
  assert.equal(m.agents.history.status, 'posting', 'message after error moves status to posting')
  assert.equal(m.lastCheckout?.verified, true)
})

check('unknown and malformed events do not throw', () => {
  let s = seedGraph(initialState(), seed)
  const bad = [
    { type: 'something.new', foo: 1 },
    { type: 'evidence.attached' },
    { type: 'agent.joined', agent: 'nobody' },
    { type: 'verdict' },
    { type: 'case.opened' },
    null,
    undefined,
    42,
    'reset',
  ] as unknown as LiveEvent[]
  for (const e of bad) s = applyEvent(s, e)
  assert.equal(s.seq, bad.length)
  assert.ok(s.unknownEvents >= 5)
  assert.ok(!s.case)
})

check('events from another case never touch the case on screen', () => {
  let s = seedGraph(initialState(), seed)
  s = applyEvent(s, { type: 'case.opened', case_id: 'case_a', kind: 'dispute', order_id: 'ord_doubledip', customer_id: 'cus_doubledip', customer_name: 'Theo', title: 'A', summary: 's', amount: 10, population: 'human', flags: [], room: null })
  assert.ok(!isForeignCaseEvent(s, { type: 'agent.joined', case_id: 'case_a', agent: 'critic', handle: 'c' }))
  assert.ok(isForeignCaseEvent(s, { type: 'agent.joined', case_id: 'case_b', agent: 'critic', handle: 'c' }))
  assert.ok(!isForeignCaseEvent(s, { type: 'case.opened', case_id: 'case_b', kind: 'dispute', order_id: 'ord_other', customer_id: 'cus_doubledip', customer_name: 'Theo', title: 'B', summary: 's', amount: 10, population: 'human', flags: [], room: null }))
  const before = s
  s = applyEvent(s, { type: 'evidence.attached', case_id: 'case_b', agent: 'history', evidence: { id: 'ev_b', family: 'velocity', label: 'x', detail: 'x', severity: 'critical', weight: 0.1, node_ids: ['ord_other'] } })
  s = applyEvent(s, { type: 'verdict', case_id: 'case_b', tier: 'instant_refund', confidence: 0.9, score: 0.9, rationale: 'r', evidence_ids: [] })
  s = applyEvent(s, { type: 'case.closed', case_id: 'case_b', outcome: 'done' })
  assert.equal(s.evidence.length, 0)
  assert.equal(s.verdict, null)
  assert.equal(s.case?.closed, false)
  assert.equal(s.transcript.length, before.transcript.length)
  assert.equal(s.seq, before.seq + 3, 'foreign events still count as applied')
  s = applyEvent(s, { type: 'case.closed', case_id: 'case_a', outcome: 'done' })
  assert.equal(s.case?.closed, true)
  assert.ok(!hasLiveCase(s))
})

check('checkout orders survive a case opening', () => {
  let s = seedGraph(initialState(), seed)
  s = applyEvent(s, { type: 'checkout.observed', order_id: 'ord_fresh', population: 'signed', score: 0.1, signals: [], signature: { verified: true, signature_agent: 'muse', keyid: 'k', tag: 't' } })
  assert.ok(s.graph.byId['ord_fresh'])
  s = applyEvent(s, { type: 'case.opened', case_id: 'case_c', kind: 'return', order_id: 'ord_doubledip', customer_id: 'cus_doubledip', customer_name: 'Theo', title: 'C', summary: 's', amount: 1, population: 'human', flags: [], room: null })
  assert.ok(s.graph.byId['ord_fresh'], 'checkout node kept through case.opened')
  s = applyEvent(s, { type: 'reset' })
  assert.ok(s.graph.byId['ord_fresh'], 'checkout node kept through reset')
  assert.equal(s.graph.nodes.filter((n) => n.id === 'ord_fresh').length, 1)
})

check('feed frames parse per the contract', () => {
  const ev = { type: 'agent.joined', case_id: 'c', agent: 'critic', handle: 'critic-agent' }
  assert.deepEqual(parseFrame(JSON.stringify({ type: 'agent.joined', payload: ev, at: 1 })), ev)
  assert.deepEqual(parseFrame({ type: 'agent.joined', payload: ev, at: 1 }), ev)
  assert.deepEqual(parseFrame(JSON.stringify({ type: 'reset', payload: {}, at: 1 })), { type: 'reset' })
  assert.deepEqual(parseFrame(JSON.stringify(ev)), ev)
  assert.equal(parseFrame('not json'), null)
  assert.equal(parseFrame(JSON.stringify({ at: 1 })), null)
  assert.equal(parseFrame(null), null)
  assert.equal(parseFrame(JSON.stringify({ type: 'x', payload: 'garbage' })), null)
})

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures' : ''}`)
