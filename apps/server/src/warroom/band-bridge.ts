import { AGENT_NAMES, type AgentName } from '@receipts/seed'
import { BandAgentClient, type BandMessage } from '../band.js'
import { bandCredentials, requireEnv } from '../env.js'
import { markReplied, runSpecialist, setTransport, type Transport } from './cases.js'

interface Identity {
  role: AgentName
  client: BandAgentClient
  id: string
  name: string
  handle: string
}

const POLL_MS = 1_500

/**
 * Binds each ZooWork specialist to its Band identity. Band is the coordination layer: the critic's
 * @mentions wake the specialists, and their replies reach the critic through the room.
 */
export async function startBandBridge(): Promise<Transport | null> {
  const identities = new Map<AgentName, Identity>()
  for (const role of AGENT_NAMES) {
    const { apiKey } = bandCredentials(role)
    const client = new BandAgentClient(role, apiKey)
    const me = await client.me()
    identities.set(role, { role, client, id: me.id, name: me.name, handle: me.handle })
  }
  const critic = identities.get('critic')!
  const room = await critic.client.findRoomByTitle(requireEnv('BAND_ROOM'))
  if (!room) {
    console.warn('[band] room not found; war room will run in-process')
    return null
  }
  const byId = new Map([...identities.values()].map((i) => [i.id, i.role]))

  const transport: Transport = {
    room: () => ({ id: room.id, title: room.title ?? 'Dispute War Room' }),
    async post(from, text, mentions) {
      const me = identities.get(from)!
      const sent = await me.client.send(room.id, text, mentions.map((m) => ({ id: identities.get(m)!.id, name: identities.get(m)!.name, handle: identities.get(m)!.handle })))
      return sent.id
    },
  }

  const caseOf = (m: BandMessage): string | undefined => /case:(case_[A-Za-z0-9_]+)/.exec(m.content)?.[1]

  for (const me of identities.values()) {
    let busy = false
    setInterval(async () => {
      if (busy) return
      busy = true
      try {
        const msg = await me.client.nextMessage(room.id)
        if (!msg) return
        console.log(`[band] ${me.role} <- ${msg.sender_name}: ${msg.content.slice(0, 70).replace(/\n/g, ' ')}`)
        try {
          // A 409 (already processing after a restart) or a transient error must not stop us from marking it processed below.
          await me.client.markProcessing(room.id, msg.id).catch((err: Error) => console.warn(`[band] ${me.role} markProcessing:`, err.message))
          const caseId = caseOf(msg)
          const from = byId.get(msg.sender_id)
          if (caseId && me.role === 'critic' && from && from !== 'critic') markReplied(caseId, from)
          else if (caseId && me.role !== 'critic' && from === 'critic' && !msg.content.startsWith('[verdict]')) void runSpecialist(caseId, me.role, 'band')
        } finally {
          await me.client.markProcessed(room.id, msg.id)
        }
      } catch (err) {
        console.warn(`[band] ${me.role} poll error:`, (err as Error).message)
      } finally {
        busy = false
      }
    }, POLL_MS)
  }
  setTransport(transport)
  console.log(`[band] bridge up in room "${room.title}" (${room.id}) with ${identities.size} identities`)
  return transport
}
