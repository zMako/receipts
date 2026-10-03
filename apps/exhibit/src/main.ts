/**
 * Exhibit entry point. Builds the product shell and the graph scene, loads the merchant graph and
 * stats, connects the live feed, and autoplays the offline double-dip replay once so the exhibit
 * never sits empty.
 */
import './styles.css'
import { API, type LiveEvent, type TimedEvent } from './contract'
import { connectFeed, fetchReplay, playReplay, type ReplayHandle } from './feed'
import { createPanel, type QueueItem, type Stats } from './panel'
import { createInspector } from './inspector'
import { ExhibitScene } from './scene'
import { applyEvent, hasLiveCase, initialState, isForeignCaseEvent, seedGraph, tick, type State } from './state'

const app = document.getElementById('app')!

let state: State = initialState()
let replay: ReplayHandle | null = null
let replayEvents: TimedEvent[] | null = null
let replayPromise: Promise<TimedEvent[]> | null = null
/** Bumped on every startReplay so a stale continuation (double R before the JSON loaded) bails out. */
let replayGen = 0
let liveCaseSeenAt = 0
let lastOverviewAt = 0
/** Last time the judge touched the stage; the idle overview drift must not yank the camera away. */
let lastInteractionAt = 0
let mode: 'idle' | 'replay' | 'live' = 'idle'
/** Case ids we have already seen close. The server replays the last case to every new socket. */
const seenClosed = new Set<string>()
let escapeArmedAt = 0

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
const inspector = createInspector(panel.stage.parentElement ?? panel.stage, {
  onOpenCase: (id) => {
    inspector.hide()
    void runLive(id)
  },
  onFocus: (id) => {
    scene.focusNeighbourhood(id)
    const node = state.graph.byId[id]
    if (node) void inspector.show(node, state)
  },
})
scene.onNodeSelect = (id) => {
  const node = state.graph.byId[id]
  if (node) void inspector.show(node, state)
}
for (const type of ['pointerdown', 'wheel'] as const) panel.stage.addEventListener(type, () => (lastInteractionAt = performance.now()), { passive: true })

function caseIdOf(event: LiveEvent): string | null {
  const id = (event as { case_id?: unknown }).case_id
  return typeof id === 'string' ? id : null
}

/** A live event for a case we already watched close is the server's reconnect replay; ignore it. */
function isStaleLiveEvent(event: LiveEvent): boolean {
  const id = caseIdOf(event)
  if (!id || !seenClosed.has(id)) return false
  // The one legitimate post-close event: the judge's Stripe approval for the case still on screen.
  if (event.type === 'stripe.submitted' && state.case?.case_id === id && state.stripe && !state.stripe.submitted) return false
  return true
}

function dispatch(event: LiveEvent, source: 'live' | 'replay') {
  if (source === 'live' && replay && event.type !== 'hello') {
    // A live case pre-empts the offline replay.
    if (event.type === 'case.opened' || event.type === 'reset') stopReplay()
    else return
  }
  if (source === 'live' && isStaleLiveEvent(event)) return
  if (source === 'live' && event.type === 'case.opened') {
    liveCaseSeenAt = performance.now()
    setMode('live')
  }
  // Events from another case never touch the case on screen (the reducer drops them too).
  const foreign = isForeignCaseEvent(state, event)
  state = applyEvent(state, event)
  if (foreign) return
  scene.onEvent(event, state)
  scene.setGraph(state)
  panel.render(state)
  if (event.type === 'case.closed' || event.type === 'reset') {
    if (source === 'live') {
      if (event.type === 'case.closed') seenClosed.add(event.case_id)
      setMode('idle')
    }
    lastOverviewAt = performance.now()
    idleSince = performance.now()
  }
  if (source === 'live' && event.type === 'hello' && event.active_case === null && mode === 'live' && hasLiveCase(state) && state.case) {
    // The server came back without our case: it restarted mid-run. Close it locally so the exhibit
    // does not sit on "Live case" with thinking agents forever.
    dispatch({ type: 'case.closed', case_id: state.case.case_id, outcome: 'server restarted before the case closed' }, 'live')
    panel.toast('The server restarted mid-case; the war room was lost.', 'warn')
    return
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

function loadReplayEvents(): Promise<TimedEvent[]> {
  if (replayEvents) return Promise.resolve(replayEvents)
  replayPromise ??= fetchReplay('doubledip')
    .then((events) => (replayEvents = events))
    .finally(() => (replayPromise = null))
  return replayPromise
}

async function startReplay() {
  stopReplay()
  const gen = ++replayGen
  let events: TimedEvent[]
  try {
    events = await loadReplayEvents()
  } catch (err) {
    if (gen === replayGen) panel.toast(`Replay unavailable: ${(err as Error).message}`, 'error')
    return
  }
  // A newer startReplay (or a live case) took over while the JSON was loading.
  if (gen !== replayGen || replay) return
  if (!events.length) {
    panel.toast('Replay is empty', 'warn')
    return
  }
  // Start from a clean case so the story reads the same every time.
  if (state.case) dispatch({ type: 'reset' }, 'replay')
  setMode('replay')
  const handle = playReplay(events, (event) => dispatch(event, 'replay'))
  replay = handle
  const ok = await handle.done
  if (replay === handle && ok) {
    replay = null
    setMode('idle')
    lastOverviewAt = performance.now()
  }
}

/** The panel disables the approve button before calling onSubmit; a failed submit must hand it back. */
function releaseSubmitButton() {
  const btn = app.querySelector<HTMLButtonElement>('button[data-submit]')
  if (!btn) return
  btn.disabled = false
  btn.dataset.armed = '0'
  btn.classList.remove('armed')
  btn.textContent = 'Approve and submit to Stripe'
}

async function submit(caseId: string) {
  try {
    const res = await fetch(API.submitCase(caseId), { method: 'POST' })
    const json = (await res.json().catch(() => ({}))) as { status?: string; error?: string }
    if (!res.ok) {
      panel.toast(`Could not submit: ${json.error ?? `HTTP ${res.status}`}`, 'error')
      releaseSubmitButton()
      panel.render(state)
      return
    }
    panel.toast(`Submitted to Stripe. Dispute status: ${(json.status ?? 'under review').replace(/_/g, ' ')}.`)
    void refreshQueue()
  } catch (err) {
    panel.toast(`Could not reach the server: ${(err as Error).message}`, 'error')
    releaseSubmitButton()
  }
}

/** Open a hero case live. Dispute ids start with `dp_`, return ids start with `ret_`. */
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
    liveCaseSeenAt = performance.now()
    setMode('live')
  } catch (err) {
    panel.toast(`Could not reach the server: ${(err as Error).message}`, 'error')
  }
}

async function reset() {
  inspector.hide()
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
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if (e.key === 'r' || e.key === 'R') void startReplay()
  else if (e.key === 'Escape') {
    // Resetting a live case kills a billable war room: ask for a second press within 2 s.
    if (mode === 'live' && hasLiveCase(state) && performance.now() - escapeArmedAt > 2000) {
      escapeArmedAt = performance.now()
      panel.toast('Press Esc again to abandon the live case.', 'warn')
      return
    }
    escapeArmedAt = 0
    void reset()
  }
})

let last = performance.now()
function loop(now: number) {
  const dt = (now - last) / 1000
  last = now
  const next = tick(state, dt)
  if (next !== state) state = next
  scene.frame(state, dt)
  // After a story ends, drift back to the overview so the next judge sees the whole graph, unless
  // someone has been inspecting the graph since.
  if (mode === 'idle' && lastOverviewAt && now - lastOverviewAt > 25_000) {
    const storyEndedAt = lastOverviewAt
    lastOverviewAt = 0
    if (lastInteractionAt < storyEndedAt) scene.focusOverview()
  }
  // A live case that went quiet for a long time should not freeze the exhibit.
  if (mode === 'live' && liveCaseSeenAt && now - liveCaseSeenAt > 10 * 60_000 && !hasLiveCase(state)) setMode('idle')
  // Unattended gallery mode: after 20 idle seconds, open the next new case.
  if (autoRun && mode === 'idle' && !hasLiveCase(state) && !replay && now - idleSince > 20_000) {
    idleSince = now
    const next = queue.find((q) => !q.case)
    if (next) void runLive(next.id)
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

void boot()
