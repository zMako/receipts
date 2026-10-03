import '../src/env.js'
import { bandCredentials, requireEnv } from '../src/env.js'
import { BandAgentClient } from '../src/band.js'
import { ensureAgent, ask } from '../src/zoowork.js'

async function main() {
  console.log('== ZooWork hello ==')
  const agentId = await ensureAgent('receipts-critic', () => ({
    persona: {
      docs: [
        {
          name: 'role',
          content:
            'You are the Critic in Receipts, a merchant-side returns-abuse and dispute screener. You weigh evidence from specialist agents and return a tiered verdict. Keep answers terse.',
        },
      ],
    },
    include_global_skills: false,
    skills: [],
  }))
  console.log('agent:', agentId)
  const reply = await ask(agentId, 'Reply with exactly: Receipts online.')
  console.log('reply:', JSON.stringify(reply.trim()))

  console.log('\n== Band room round-trip ==')
  const room = requireEnv('BAND_ROOM')
  const critic = new BandAgentClient('critic', bandCredentials('critic').apiKey)
  const identity = new BandAgentClient('identity', bandCredentials('identity').apiKey)
  const roomRec = await critic.findRoomByTitle(room)
  if (!roomRec) throw new Error('room not found')
  const idMe = await identity.me()
  const sent = await critic.send(roomRec.id, `Smoke test from Receipts server. @${idMe.name} please acknowledge.`, [
    { id: idMe.id, name: idMe.name, handle: idMe.handle },
  ])
  console.log('critic sent message', sent.id)

  for (let i = 0; i < 10; i++) {
    const msg = await identity.nextMessage(roomRec.id)
    if (msg) {
      console.log('identity received:', JSON.stringify(msg.content), 'from', msg.sender_name)
      await identity.markProcessing(roomRec.id, msg.id)
      const criticMe = await critic.me()
      await identity.send(roomRec.id, `Acknowledged, @${criticMe.name}. Identity agent online.`, [
        { id: criticMe.id, name: criticMe.name, handle: criticMe.handle },
      ])
      await identity.markProcessed(roomRec.id, msg.id)
      console.log('identity replied and marked processed')
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log('identity saw no message within 10s')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
