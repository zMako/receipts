/**
 * Live feed: WebSocket at ws(s)://<host>/live, frames are `{ type, payload, at }` where payload is
 * the LiveEvent. Reconnects with capped exponential backoff. Also hosts the offline replay player,
 * which schedules TimedEvents by their at_ms offsets and can be cancelled.
 */
import type { LiveEvent, TimedEvent } from './contract'

export type FeedStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface FeedHandle {
  close(): void
  status(): FeedStatus
}

/** Extract the LiveEvent from a raw frame. Returns null when the frame carries no usable event. */
export function parseFrame(raw: unknown): LiveEvent | null {
  let frame: unknown = raw
  if (typeof frame === 'string') {
    try {
      frame = JSON.parse(frame)
    } catch {
      return null
    }
  }
  if (!frame || typeof frame !== 'object') return null
  const f = frame as { type?: unknown; payload?: unknown }
  let payload: unknown = f.payload
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      payload = null
    }
  }
  if (payload && typeof payload === 'object') {
    const p = payload as { type?: unknown }
    if (typeof p.type === 'string') return p as LiveEvent
    // Payload without its own type: the envelope type names it.
    if (typeof f.type === 'string') return { ...(payload as object), type: f.type } as LiveEvent
    return null
  }
  // An envelope whose payload is unusable carries nothing.
  if ('payload' in f) return null
  // Bare event (no envelope).
  if (typeof f.type === 'string' && f.type !== '') return frame as LiveEvent
  return null
}

export function liveUrl(path = '/live'): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}

export function connectFeed(opts: { onEvent: (event: LiveEvent) => void; onStatus?: (status: FeedStatus, attempt: number) => void; url?: string }): FeedHandle {
  const url = opts.url ?? liveUrl()
  let ws: WebSocket | null = null
  let status: FeedStatus = 'connecting'
  let attempt = 0
  let timer: number | null = null
  let closed = false

  const setStatus = (s: FeedStatus) => {
    status = s
    try {
      opts.onStatus?.(s, attempt)
    } catch {
      /* listener errors never break the feed */
    }
  }

  const scheduleReconnect = () => {
    if (closed || timer !== null) return
    const delay = Math.min(15_000, 700 * 2 ** Math.min(attempt, 5)) + Math.random() * 400
    attempt++
    setStatus('reconnecting')
    timer = window.setTimeout(() => {
      timer = null
      open()
    }, delay)
  }

  const open = () => {
    if (closed) return
    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }
    setStatus(attempt ? 'reconnecting' : 'connecting')
    ws.onopen = () => {
      attempt = 0
      setStatus('open')
    }
    ws.onmessage = (msg) => {
      const event = parseFrame(msg.data)
      if (!event) return
      try {
        opts.onEvent(event)
      } catch (err) {
        console.warn('[feed] handler failed', err)
      }
    }
    ws.onerror = () => {
      /* onclose follows */
    }
    ws.onclose = () => {
      ws = null
      if (closed) setStatus('closed')
      else scheduleReconnect()
    }
  }

  open()

  return {
    close() {
      closed = true
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      setStatus('closed')
    },
    status: () => status,
  }
}

export interface ReplayHandle {
  cancel(): void
  readonly done: Promise<boolean>
  /** Milliseconds elapsed in replay time. */
  elapsed(): number
}

/** Play timed events locally. Resolves `done` with true when every event fired, false if cancelled. */
export function playReplay(
  events: TimedEvent[],
  onEvent: (event: LiveEvent, index: number) => void,
  opts: { speed?: number; onProgress?: (index: number, total: number) => void } = {},
): ReplayHandle {
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1
  const queue = [...(Array.isArray(events) ? events : [])]
    .filter((e) => e && typeof e.at_ms === 'number' && e.event)
    .sort((a, b) => a.at_ms - b.at_ms)
  const start = performance.now()
  let timer: number | null = null
  let cancelled = false
  let i = 0
  let resolve!: (ok: boolean) => void
  const done = new Promise<boolean>((r) => (resolve = r))

  const pump = () => {
    timer = null
    if (cancelled) return
    const now = performance.now()
    while (i < queue.length && queue[i].at_ms / speed <= now - start + 1) {
      const item = queue[i++]
      try {
        onEvent(item.event, i - 1)
      } catch (err) {
        console.warn('[replay] handler failed', err)
      }
      opts.onProgress?.(i, queue.length)
    }
    if (i >= queue.length) {
      resolve(true)
      return
    }
    const wait = Math.max(0, queue[i].at_ms / speed - (performance.now() - start))
    timer = window.setTimeout(pump, wait)
  }

  if (queue.length) pump()
  else resolve(true)

  return {
    cancel() {
      if (cancelled) return
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      timer = null
      resolve(false)
    },
    done,
    elapsed: () => (performance.now() - start) * speed,
  }
}

export async function fetchReplay(name: string): Promise<TimedEvent[]> {
  const res = await fetch(`/api/replay/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(`replay ${name}: HTTP ${res.status}`)
  const body = (await res.json()) as unknown
  return Array.isArray(body) ? (body as TimedEvent[]) : []
}
