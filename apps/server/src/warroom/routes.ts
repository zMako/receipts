import { Router } from 'express'
import { data, vaultFor } from '../store.js'
import { activeCase, getCase, listCases, openCase, resetCases, submitCase } from './cases.js'

const HERO_IDS = ['dp_doubledip', 'ret_aiphoto', 'ret_loyal_defect', 'dp_signed']

export const warroomApi = Router()
export const readiness = { agents: false, band: false, error: undefined as string | undefined }

warroomApi.get('/cases', (_req, res) => res.json(listCases().map(({ events, vault, ...c }) => ({ ...c, events: events.length, population: vault.population }))))
warroomApi.get('/cases/active', (_req, res) => {
  const c = activeCase()
  res.json(c ? { ...c, vault: undefined } : null)
})
warroomApi.get('/cases/:id', (req, res) => {
  const c = getCase(req.params.id)
  if (!c) return res.status(404).json({ error: 'case_not_found' })
  res.json({ ...c, vault: undefined })
})
warroomApi.post('/cases/open', async (req, res) => {
  if (!readiness.agents) return res.status(503).json({ error: 'agents_not_ready', detail: readiness.error })
  try {
    const c = await openCase({ dispute_id: req.body?.dispute_id, return_id: req.body?.return_id })
    res.status(201).json({ case_id: c.id, kind: c.kind, order_id: c.order_id, room: c.events[0]?.type === 'case.opened' ? (c.events[0] as { room: unknown }).room : null })
  } catch (err) {
    const msg = (err as Error).message
    res.status(msg === 'case_running' ? 409 : 400).json({ error: msg })
  }
})
warroomApi.post('/cases/:id/submit', async (req, res) => {
  try {
    res.json(await submitCase(req.params.id))
  } catch (err) {
    const msg = (err as Error).message
    res.status(msg === 'case_not_found' ? 404 : 409).json({ error: msg })
  }
})
warroomApi.post('/reset', (_req, res) => {
  resetCases()
  res.json({ ok: true })
})
warroomApi.get('/ready', (_req, res) => res.json(readiness))

/** The merchant's inbox: open chargebacks and unresolved return claims, with any case outcome so far. */
warroomApi.get('/queue', (_req, res) => {
  const latest = new Map<string, ReturnType<typeof listCases>[number]>()
  for (const c of listCases()) latest.set(c.dispute_id ?? c.return_id ?? '', c)
  const summarize = (targetId: string) => {
    const c = latest.get(targetId)
    if (!c) return null
    return { case_id: c.id, status: c.closed_at ? 'decided' : 'running', tier: c.verdict?.tier ?? null, decision: c.routing?.decision ?? null, staged: Boolean(c.stripe), submitted: Boolean(c.stripe?.submitted) }
  }
  const items: Record<string, unknown>[] = []
  for (const d of data.disputes) {
    if (d.status !== 'needs_response' && d.status !== 'warning_needs_response') continue
    const v = vaultFor(d.order_id)!
    items.push({ id: d.id, kind: 'dispute', title: `${d.network === 'visa' ? 'Visa' : 'Mastercard'} ${d.reason_code}, ${d.reason.replace(/_/g, ' ')}`, inquiry: d.is_inquiry, order_id: d.order_id, customer_name: v.customer_name, amount: d.amount, due_by: d.evidence_due_by, received_at: d.created_at, population: v.population, flags: v.flags, statement: d.cardholder_statement, hero: HERO_IDS.includes(d.id), case: summarize(d.id) })
  }
  for (const r of data.returns) {
    if (!(r.status === 'requested' || (r.status === 'received' && !r.refund))) continue
    const v = vaultFor(r.order_id)!
    items.push({ id: r.id, kind: 'return', title: `${r.kind.replace(/_/g, ' ')}, ${r.reason.replace(/_/g, ' ')}`, inquiry: false, order_id: r.order_id, customer_name: v.customer_name, amount: r.amount, due_by: null, received_at: r.requested_at, population: v.population, flags: v.flags, statement: r.claim_text, hero: HERO_IDS.includes(r.id), case: summarize(r.id) })
  }
  const rank = (it: Record<string, unknown>) => {
    const c = it.case as { status: string } | null
    return (c?.status === 'running' ? 0 : it.hero ? 1 : c?.status === 'decided' ? 3 : 2)
  }
  items.sort((a, b) => rank(a) - rank(b) || String(a.due_by ?? '9').localeCompare(String(b.due_by ?? '9')) || String(a.received_at).localeCompare(String(b.received_at)))
  res.json(items)
})
