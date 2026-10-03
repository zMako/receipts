import { Router } from 'express'
import { activeCase, getCase, listCases, openCase, resetCases } from './cases.js'

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
    res.status(400).json({ error: (err as Error).message })
  }
})
warroomApi.post('/reset', (_req, res) => {
  resetCases()
  res.json({ ok: true })
})
warroomApi.get('/ready', (_req, res) => res.json(readiness))
