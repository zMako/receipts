import { Router } from 'express'
import { REPLAYS } from '@receipts/seed'
import { allVaults, data, graph, vaultFor, vaults } from './store.js'

export const api = Router()

api.get('/merchant', (_req, res) => res.json(data.merchant))
api.get('/heroes', (_req, res) => res.json(data.heroes))

api.get('/stats', (_req, res) => {
  const vs = allVaults()
  const byPopulation: Record<string, number> = {}
  const byFlag: Record<string, number> = {}
  for (const v of vs) {
    byPopulation[v.population] = (byPopulation[v.population] ?? 0) + 1
    for (const f of v.flags) byFlag[f] = (byFlag[f] ?? 0) + 1
  }
  const vamp = data.merchant.vamp
  res.json({
    orders: vs.length,
    customers: data.customers.length,
    returns: data.returns.length,
    disputes: data.disputes.length,
    by_population: byPopulation,
    by_flag: byFlag,
    vamp: { ...vamp, ratio: Math.round(((vamp.tc40 + vamp.tc15) / vamp.tc05) * 10000) / 10000, headroom_items: Math.floor(vamp.threshold * vamp.tc05) - (vamp.tc40 + vamp.tc15) },
  })
})

api.get('/orders', (req, res) => {
  const population = typeof req.query.population === 'string' ? req.query.population : undefined
  const flag = typeof req.query.flag === 'string' ? req.query.flag : undefined
  const limit = Math.min(Number(req.query.limit ?? 500), 1000)
  const rows = allVaults()
    .filter((v) => !population || v.population === population)
    .filter((v) => !flag || v.flags.includes(flag))
    .slice(0, limit)
    .map((v) => ({ order_id: v.order_id, customer_id: v.customer_id, customer_name: v.customer_name, placed_at: v.placed_at, total: v.total, population: v.population, population_score: v.population_score, flags: v.flags, returns: v.returns.length, disputes: v.disputes.length }))
  res.json(rows)
})

api.get('/orders/:id', (req, res) => {
  const o = vaults.order(req.params.id)
  if (!o) return res.status(404).json({ error: 'order_not_found' })
  res.json(o)
})

api.get('/orders/:id/evidence', (req, res) => {
  const v = vaultFor(req.params.id)
  if (!v) return res.status(404).json({ error: 'order_not_found' })
  res.json(v)
})

api.get('/customers/:id', (req, res) => {
  const c = vaults.customer(req.params.id)
  if (!c) return res.status(404).json({ error: 'customer_not_found' })
  const orders = vaults.ordersFor(c.id).map((o) => vaultFor(o.id)!)
  res.json({ customer: c, history: vaults.history(c.id, vaults.now), orders: orders.map((v) => ({ order_id: v.order_id, placed_at: v.placed_at, total: v.total, population: v.population, flags: v.flags, returns: v.returns, disputes: v.disputes })) })
})

api.get('/returns', (_req, res) => res.json(data.returns.map((r) => ({ ...vaults.summarizeReturn(r), order_id: r.order_id, customer_id: r.customer_id }))))
api.get('/returns/:id', (req, res) => {
  const r = data.returns.find((x) => x.id === req.params.id)
  if (!r) return res.status(404).json({ error: 'return_not_found' })
  res.json({ return: r, summary: vaults.summarizeReturn(r), evidence: vaultFor(r.order_id) })
})

api.get('/disputes', (_req, res) => res.json(data.disputes.map((d) => ({ ...vaults.summarizeDispute(d), order_id: d.order_id }))))
api.get('/disputes/:id', (req, res) => {
  const d = data.disputes.find((x) => x.id === req.params.id)
  if (!d) return res.status(404).json({ error: 'dispute_not_found' })
  res.json({ dispute: d, evidence: vaultFor(d.order_id) })
})

api.get('/graph', (_req, res) => res.json(graph()))

api.get('/replay/:name', (req, res) => {
  const fn = REPLAYS[req.params.name]
  if (!fn) return res.status(404).json({ error: 'replay_not_found', available: Object.keys(REPLAYS) })
  res.json(fn())
})
