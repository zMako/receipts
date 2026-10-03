/**
 * Minimal Band REST client. The official @band-ai/sdk needs Node 22.12+, and the
 * Agent API is small enough to call directly: profile, rooms, next message, mark
 * processing/processed, send with mentions.
 */
const BASE = process.env.BAND_REST_URL ?? 'https://api.band.ai'

export interface BandProfile {
  id: string
  handle: string
  name: string
}

export interface BandRoom {
  id: string
  title: string | null
}

export interface BandMention {
  id: string
  name?: string
  handle?: string
  kind?: 'mention' | 'reference'
}

export interface BandMessage {
  id: string
  content: string
  sender_id: string
  sender_name: string
  sender_type: string
  message_type: string
  chat_room_id: string
  inserted_at: string
  metadata?: { mentions?: BandMention[] }
}

export class BandAgentClient {
  constructor(
    public readonly label: string,
    private readonly apiKey: string,
  ) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | null }> {
    const res = await fetch(`${BASE}${path}`, {
      signal: AbortSignal.timeout(12_000),
      method,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 204) return { status: 204, data: null }
    const text = await res.text()
    if (!res.ok) throw new Error(`Band ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
    const json = text ? JSON.parse(text) : null
    return { status: res.status, data: (json?.data ?? json) as T }
  }

  async me(): Promise<BandProfile> {
    const { data } = await this.req<BandProfile>('GET', '/api/v1/agent/me')
    return data!
  }

  async rooms(): Promise<BandRoom[]> {
    const { data } = await this.req<BandRoom[]>('GET', '/api/v1/agent/chats?page_size=100')
    return data ?? []
  }

  async findRoomByTitle(title: string): Promise<BandRoom | undefined> {
    const rooms = await this.rooms()
    const want = title.trim().toLowerCase()
    return rooms.find((r) => (r.title ?? '').trim().toLowerCase() === want)
  }

  async nextMessage(roomId: string): Promise<BandMessage | null> {
    const { status, data } = await this.req<BandMessage>('GET', `/api/v1/agent/chats/${roomId}/messages/next`)
    return status === 204 ? null : data
  }

  async markProcessing(roomId: string, messageId: string): Promise<void> {
    await this.req('POST', `/api/v1/agent/chats/${roomId}/messages/${messageId}/processing`)
  }

  async markProcessed(roomId: string, messageId: string): Promise<void> {
    await this.req('POST', `/api/v1/agent/chats/${roomId}/messages/${messageId}/processed`)
  }

  /** Band requires at least one @mention per message so it can route it. */
  async send(roomId: string, content: string, mentions: BandMention[]): Promise<{ id: string }> {
    const { data } = await this.req<{ id: string }>('POST', `/api/v1/agent/chats/${roomId}/messages`, {
      message: { content, mentions: mentions.map((m) => ({ kind: 'mention', ...m })) },
    })
    return data!
  }
}
