import './env.js'
import express from 'express'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { LiveEvent } from '@receipts/seed'
import { api } from './routes.js'
import { data } from './store.js'
import { ensureWarRoomAgents } from './warroom/agents.js'
import { startBandBridge } from './warroom/band-bridge.js'
import { activeCase, setBroadcast } from './warroom/cases.js'
import { readiness, warroomApi } from './warroom/routes.js'
import { setBroadcaster, verifyRouter } from './verify/index.js'

const app = express()
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => {
  ;(req as express.Request & { rawBody?: Buffer }).rawBody = buf
} }))

app.get('/health', (_req, res) => res.json({ ok: true, service: 'receipts-server', ...readiness }))
app.use('/api', api)
app.use('/api', warroomApi)
app.use(verifyRouter)

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/live' })

/** Broadcast a typed event to every connected exhibit client. */
export function broadcast(type: string, payload: unknown): void {
  const msg = JSON.stringify({ type, payload, at: Date.now() })
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(msg)
}

/** Heartbeat: clients that vanish without a close frame (sleep, Wi-Fi switch) are terminated instead of buffering every broadcast. */
const HEARTBEAT_MS = 30_000
const alive = new WeakSet<WebSocket>()
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (!alive.has(client)) {
      client.terminate()
      continue
    }
    alive.delete(client)
    client.ping()
  }
}, HEARTBEAT_MS)
wss.on('close', () => clearInterval(heartbeat))

wss.on('connection', (ws) => {
  alive.add(ws)
  ws.on('pong', () => alive.add(ws))
  const hello: LiveEvent = { type: 'hello', server_time: new Date().toISOString(), active_case: (() => { const c = activeCase(); return c && !c.closed_at ? c.id : null })(), merchant: data.merchant.name }
  ws.send(JSON.stringify({ type: hello.type, payload: hello, at: Date.now() }))
  // Late joiners get the active case replayed so the exhibit is never out of sync.
  // Late joiners only catch up on a case that is still running; a closed case stays in the queue.
  const c = activeCase()
  if (c && !c.closed_at) for (const ev of c.events) ws.send(JSON.stringify({ type: ev.type, payload: ev, at: Date.now() }))
})

setBroadcast((ev) => broadcast(ev.type, ev))
setBroadcaster(broadcast)

const port = Number(process.env.PORT ?? 8787)
server.listen(port, () => console.log(`[receipts] server on http://localhost:${port}`))

if (process.env.WARROOM !== 'off') {
  void (async () => {
    try {
      await ensureWarRoomAgents()
      readiness.agents = true
    } catch (err) {
      readiness.error = (err as Error).message
      console.error('[warroom] agent provisioning failed:', err)
    }
    try {
      readiness.band = Boolean(await startBandBridge())
    } catch (err) {
      console.error('[band] bridge failed, running in-process:', (err as Error).message)
    }
  })()
}
