import './env.js'
import express from 'express'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

const app = express()
app.use(express.json({ limit: '2mb' }))

app.get('/health', (_req, res) => res.json({ ok: true, service: 'receipts-server' }))

const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/live' })

/** Broadcast a typed event to every connected exhibit client. */
export function broadcast(type: string, payload: unknown): void {
  const msg = JSON.stringify({ type, payload, at: Date.now() })
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(msg)
}

const port = Number(process.env.PORT ?? 8787)
server.listen(port, () => console.log(`[receipts] server on http://localhost:${port}`))
