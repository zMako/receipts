/**
 * Exhibit entry point. Loads the graph and stats, builds the scene and panel, connects the live
 * feed, and autoplays the offline double-dip replay once so the exhibit never sits empty.
 */
import { API, type LiveEvent, type TimedEvent } from './contract'
import { connectFeed, fetchReplay, playReplay, type ReplayHandle } from './feed'
import { createPanel, PANEL_WIDTH, type Stats } from './panel'
import { ExhibitScene } from './scene'
import { applyEvent, hasLiveCase, initialState, seedGraph, tick, type State } from './state'

const app = document.getElementById('app')!
const stage = document.createElement('div')
stage.id = 'stage'
stage.style.cssText = 'position:fixed;inset:0;'
app.appendChild(stage)

let state: State = initialState()
let replay: ReplayHandle | null = null
let replayEvents: TimedEvent[] | null = null
let liveCaseSeenAt = 0
let lastOverviewAt = 0
let mode: 'idle' | 'replay' | 'live' = 'idle'

const scene = new ExhibitScene(stage, { panelWidth: PANEL_WIDTH })
const panel = createPanel(app, {
  onReplay: () => void startReplay(),
  onLive: () => void runLive(),
  onReset: () => void reset(),
})

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
  }
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

async function runLive() {
  stopReplay()
  try {
    const res = await fetch(API.openCase, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dispute_id: 'dp_doubledip' }) })
    if (res.status === 404) {
      panel.toast('Live war room is not wired on this server yet (POST /api/cases/open returned 404). Showing the offline replay.', 'warn')
      void startReplay()
      return
    }
    if (!res.ok) {
      panel.toast(`Could not open live case: HTTP ${res.status}`, 'error')
      return
    }
    const body = (await res.json().catch(() => ({}))) as { case_id?: string }
    panel.toast(`Live war room opened${body.case_id ? `: ${body.case_id}` : ''}. Waiting for agents…`)
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
  try {
    const res = await fetch(API.reset, { method: 'POST' })
    if (res.status === 404) panel.toast('Local state cleared (server has no /api/reset yet).', 'info')
    else if (!res.ok) panel.toast(`Server reset failed: HTTP ${res.status}`, 'warn')
    else panel.toast('Reset.')
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
  const [graph, stats] = await Promise.all([loadJson<{ nodes: unknown[]; edges: unknown[] }>(API.graph), loadJson<Stats>(API.stats)])
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

  // Give the server a moment to announce an active case over the socket before autoplaying.
  window.setTimeout(() => {
    if (!hasLiveCase(state) && !state.activeCaseId && !replay) void startReplay()
  }, 1500)
}

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if (e.key === 'r' || e.key === 'R') void startReplay()
  else if (e.key === 'l' || e.key === 'L') void runLive()
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
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

void boot()
