/**
 * Minimal server that mounts only the verifier router, for testing the agents without the full app.
 *   PORT=8790 npx tsx scripts/agents/standalone-server.ts
 * The real app mounts the same router from src/index.ts and wires setBroadcaster(broadcast).
 */
import express from 'express'
import { verifyRouter, setBroadcaster } from '../../src/verify/index.js'

const app = express()
app.use(express.json({ limit: '2mb' }))
app.get('/health', (_req, res) => res.json({ ok: true, service: 'receipts-verify-standalone' }))
app.use(verifyRouter)
setBroadcaster((type, payload) => console.log(`[broadcast] ${type} ${JSON.stringify(payload).slice(0, 160)}…`))

const port = Number(process.env.PORT ?? 8790)
app.listen(port, () => console.log(`[verify] standalone server on http://localhost:${port}`))
