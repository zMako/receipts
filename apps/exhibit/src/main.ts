/**
 * Exhibit entry point. Builds the product shell and the graph scene, loads the merchant graph and
 * stats, connects the live feed, and autoplays the offline double-dip replay once so the exhibit
 * never sits empty.
 */
import './styles.css'
import { API, type LiveEvent, type TimedEvent } from './contract'
import { connectFeed, fetchReplay, playReplay, type ReplayHandle } from './feed'
import { createPanel, type QueueItem, type Stats } from './panel'
import { ExhibitScene } from './scene'
import { applyEvent, hasLiveCase, initialState, seedGraph, tick, type State } from './state'

const app = document.getElementById('app')!

let state: State = initialState()
let replay: ReplayHandle | null = null
let replayEvents: TimedEvent[] | null = null
let liveCaseSeenAt = 0
let lastOverviewAt = 0
let mode: 'idle' | 'replay' | 'live' = 'idle'

let autoRun = false
let queue: QueueItem[] = []
let idleSince = performance.now()

const panel = createPanel(app, {
  onReplay: () => void startReplay(),
  onReset: () => void reset(),
  onOpenCase: (id) => void runLive(id),
  onSubmit: (caseId) => void submit(caseId),
  onAutoRun: (enabled) => {
    autoRun = enabled
    idleSince = performance.now()
    panel.toast(enabled ? 'Auto-run on: the next new case opens after 20 idle seconds.' : 'Auto-run off.')
  },
})

async function refreshQueue() {
  const items = await loadJson<QueueItem[]>('/api/queue')
  if (items) {
    queue = items
    panel.setQueue(items)
  }
}
const scene = new ExhibitScene(panel.stage)

function dispatch(event: LiveEvent, source: 'live' | 'replay') {
  if (source === 'live' && replay && event.type !== 'hello') {
    // A live case pre-empts the offline replay.
    if (event.type === 'case.opened' || event.type === 'reset') stopReplay()
    else return
  }
  if (source === 'live' && event.type === 'case.opened') {
    liveCaseSeenAt = performance.now()
    setMode('live')
  }
  state = applyEvent(state, event)
  scene.onEvent(event, state)
  scene.setGraph(state)
  panel.render(state)
  if (event.type === 'case.closed' || event.type === 'reset') {
    if (source === 'live') setMode('idle')
    lastOverviewAt = performance.now()
    idleSince = performance.now()
  }
  if (source === 'live' && (event.type === 'case.opened' || event.type === 'case.closed' || event.type === 'verdict' || event.type === 'dispute.routing' || event.type === 'stripe.evidence_staged')) void refreshQueue()
}

function setMode(m: typeof mode) {
  mode = m
  panel.setMode(m)
}

function stopReplay() {
  replay?.cancel()
  replay = null
  if (mode === 'replay') setMode('idle')
}

async function loadReplayEvents(): Promise<TimedEvent[]> {
  if (replayEvents) return replayEvents
  replayEvents = await fetchReplay('doubledip')
  return replayEvents
}

async function startReplay() {
  stopReplay()
  let events: TimedEvent[]
  try {
    events = await loadReplayEvents()
  } catch (err) {
    panel.toast(`Replay unavailable: ${(err as Error).message}`, 'error')
    return
  }
  if (!events.length) {
    panel.toast('Replay is empty', 'warn')
    return
  }
  // Start from a clean case so the story reads the same every time.
  if (state.case) dispatch({ type: 'reset' }, 'replay')
  setMode('replay')
  replay = playReplay(events, (event) => dispatch(event, 'replay'))
  const ok = await replay.done
  if (replay && ok) {
    replay = null
    setMode('idle')
    lastOverviewAt = performance.now()
  }
}

async function submit(caseId: string) {
  try {
    const res = await fetch(API.submitCase(caseId), { method: 'POST' })
    const json = (await res.json().catch(() => ({}))) as { status?: string; error?: string }
    if (!res.ok) {
      panel.toast(`Could not submit: ${json.error ?? `HTTP ${res.status}`}`, 'error')
      panel.render(state)
      return
    }
    panel.toast(`Submitted to Stripe. Dispute status: ${(json.status ?? 'under review').replace(/_/g, ' ')}.`)
    void refreshQueue()
  } catch (err) {
    panel.toast(`Could not reach the server: ${(err as Error).message}`, 'error')
  }
}

/** Open a hero case live. Dispute ids start with `dp_`, return ids with `ret_`. */
async function runLive(id: string) {
  stopReplay()
  const body = id.startsWith('ret_') ? { return_id: id } : { dispute_id: id }
  try {
    const res = await fetch(API.openCase, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (res.status === 404) {
      panel.toast('Live war room is not wired on this server yet (POST /api/cases/open returned 404). Showing the offline replay.', 'warn')
      void startReplay()
      return
    }
    if (res.status === 503) {
      panel.toast('Agents are not ready yet; try again in a moment.', 'warn')
      return
    }
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: string } | null
      panel.toast(`Could not open live case: ${detail?.error ?? `HTTP ${res.status}`}`, 'error')
      return
    }
    const json = (await res.json().catch(() => ({}))) as { case_id?: string }
    panel.toast('Case opened. The critic is briefing the specialists in the Band room.')
    if (json.case_id) void refreshQueue()
    setMode('live')
  } catch (err) {
    panel.toast(`Could not reach the server: ${(err as Error).message}`, 'error')
  }
}

async function reset() {
  stopReplay()
  dispatch({ type: 'reset' }, 'replay')
  setMode('idle')
  scene.focusOverview()
  void refreshQueue()
  try {
    const res = await fetch(API.reset, { method: 'POST' })
    if (res.status === 404) panel.toast('Local state cleared (server has no /api/reset yet).', 'info')
    else if (!res.ok) panel.toast(`Server reset failed: HTTP ${res.status}`, 'warn')
    else panel.toast('Back to the queue.')
  } catch {
    panel.toast('Local state cleared; server unreachable.', 'warn')
  }
}

async function loadJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } catch (err) {
    console.warn(`[exhibit] ${url} failed`, err)
    return null
  }
}

async function boot() {
  const [graph, stats] = await Promise.all([loadJson<{ nodes: unknown[]; edges: unknown[] }>(API.graph), loadJson<Stats>(API.stats), refreshQueue()])
  if (graph) {
    state = seedGraph(state, graph)
    scene.setGraph(state)
  } else {
    panel.toast('Could not load /api/graph; is the server running?', 'error')
  }
  panel.setStats(stats)
  panel.render(state)

  connectFeed({
    onEvent: (event) => dispatch(event, 'live'),
    onStatus: (status, attempt) => panel.setConnection(status === 'open' ? 'live' : status === 'reconnecting' ? `reconnecting (${attempt})` : status, status === 'open'),
  })

  window.setInterval(() => void refreshQueue(), 20_000)
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if (e.key === 'r' || e.key === 'R') void startReplay()
  else if (e.key === 'Escape') void reset()
})

let last = performance.now()
function loop(now: number) {
  const dt = (now - last) / 1000
  last = now
  const next = tick(state, dt)
  if (next !== state) state = next
  scene.frame(state, dt)
  // After a story ends, drift back to the overview so the next judge sees the whole graph.
  if (mode === 'idle' && lastOverviewAt && now - lastOverviewAt > 25_000) {
    lastOverviewAt = 0
    scene.focusOverview()
  }
  // A live case that went quiet for a long time should not freeze the exhibit.
  if (mode === 'live' && liveCaseSeenAt && now - liveCaseSeenAt > 10 * 60_000 && !hasLiveCase(state)) setMode('idle')
  // Unattended gallery mode: after 20 idle seconds, open the next new case.
  if (autoRun && mode === 'idle' && !state.case && !replay && now - idleSince > 20_000) {
    idleSince = now
    const next = queue.find((q) => !q.case)
    if (next) void runLive(next.id)
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

void boot()
