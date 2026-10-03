/**
 * Product shell. Left: a four-step progress bar, the queue of open chargebacks and claims (when no
 * case is open) or the case, verdict, routing and Stripe cards. Centre: the graph. Right: the case
 * outline (each agent with its findings) and a collapsed transcript. Plain DOM, no framework.
 * `render(state)` is called after every event (not per frame); countdowns tick on their own timer.
 */
import { AGENT_META, AGENT_NAMES, type AgentName } from './contract'
import type { State } from './state'
import { AGENT_COLOR, POPULATION, ROUTING_TINT, TIER_TINT, populationOf, severityOf } from './theme'

export interface Stats {
  orders?: number
  customers?: number
  returns?: number
  disputes?: number
  by_population?: Record<string, number>
  vamp?: { ratio?: number; threshold?: number; headroom_items?: number; tc05?: number; tc40?: number; tc15?: number; window?: string }
}

export interface QueueItem {
  id: string
  kind: 'dispute' | 'return'
  title: string
  inquiry: boolean
  order_id: string
  customer_name: string
  amount: number
  due_by: string | null
  received_at: string
  population: string
  flags: string[]
  statement: string
  hero: boolean
  case: { case_id: string; status: 'running' | 'decided'; tier: string | null; decision: string | null; staged: boolean } | null
}

export type PanelMode = 'idle' | 'replay' | 'live'

export interface PanelHandlers {
  onReplay(): void
  onReset(): void
  /** Open a queue item live. `id` is a dispute (dp_*) or return (ret_*) id. */
  onOpenCase(id: string): void
  onAutoRun(enabled: boolean): void
  /** Merchant approval: submit the staged Stripe package for the active case. */
  onSubmit(caseId: string): void
}

export interface Panel {
  readonly stage: HTMLElement
  render(state: State): void
  setStats(stats: Stats | null): void
  setQueue(items: QueueItem[]): void
  setConnection(label: string, ok: boolean): void
  setAutoRun(enabled: boolean): void
  setMode(mode: PanelMode): void
  toast(message: string, kind?: 'info' | 'warn' | 'error'): void
  destroy(): void
}

const STEPS = [
  { title: 'Pick a case', hint: 'Open chargebacks and return claims wait in the queue. Choose one to put the agents on it.' },
  { title: 'Agents investigate', hint: 'Four ZooWork agents pull evidence from the order vault and attach findings. The critic coordinates them through the Band room.' },
  { title: 'Critic decides', hint: 'A tiered verdict: instant refund, exchange first, refund on inspection, require verification, or decline.' },
  { title: 'Evidence package', hint: 'For chargebacks: refund-and-close or represent, and the evidence package staged on the payments rail for a human to approve.' },
]

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function money(n: number): string {
  return `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function pct(n: number, digits = 2): string {
  return `${((Number(n) || 0) * 100).toFixed(digits)}%`
}

function words(s: string): string {
  return String(s ?? '').replace(/_/g, ' ')
}

export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'overdue'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (x: number) => String(x).padStart(2, '0')
  return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m ${pad(sec)}s` : `${pad(h)}:${pad(m)}:${pad(sec)}`
}

function dueShort(due: string | null): string {
  if (!due) return 'no deadline'
  const ms = new Date(due).getTime() - Date.now()
  if (ms <= 0) return 'overdue'
  const d = Math.floor(ms / 86_400_000)
  if (d >= 1) return `due in ${d} day${d === 1 ? '' : 's'}`
  return `due in ${Math.max(1, Math.floor(ms / 3_600_000))} h`
}

function agentColor(agent: AgentName | undefined): string {
  return agent ? AGENT_COLOR[agent] ?? '#94a3b8' : '#94a3b8'
}

function withMentions(text: string): string {
  return esc(text).replace(/@(history|logistics|identity|forensics|critic)\b/g, (_m, a: AgentName) => `<span class="mention" style="color:${AGENT_COLOR[a]}">@${a}</span>`)
}

function populationBadge(pop: string | undefined): string {
  const p = populationOf(pop)
  return `<span class="badge"><i style="background:${p.color}"></i>${esc(p.label)}</span>`
}

/** Short tool name for the status pill: `trace_return(ret_x)` -> `trace_return`. */
function toolName(detail: string | null): string {
  if (!detail) return 'tool'
  const m = /^\s*([a-zA-Z0-9_.-]+)/.exec(detail)
  return m ? m[1] : detail.slice(0, 24)
}

function stepOf(s: State): number {
  if (!s.case) return 0
  if (s.case.kind === 'dispute' ? s.stripe || s.routing : s.verdict && s.case.closed) return 3
  if (s.verdict) return 2
  return 1
}

export function createPanel(root: HTMLElement, handlers: PanelHandlers): Panel {
  root.innerHTML = `
    <header id="topbar">
      <h1 class="wordmark"><i aria-hidden="true"></i>Receipts</h1>
      <div class="sep" aria-hidden="true"></div>
      <div class="merchant" id="t-merchant"></div>
      <div class="chips" id="t-chips"></div>
      <div class="spacer"></div>
      <div class="actions">
        <label class="toggle" title="When idle, open the next new case automatically"><input type="checkbox" id="b-auto" /><span>Auto-run queue</span></label>
        <button class="ghost" id="b-replay" aria-keyshortcuts="R">Demo replay<kbd aria-hidden="true">R</kbd></button>
        <button class="ghost" id="b-reset" aria-keyshortcuts="Escape">Back to queue<kbd aria-hidden="true">Esc</kbd></button>
        <div class="status" id="t-status" role="status" aria-live="polite"><i aria-hidden="true"></i><span>connecting</span></div>
      </div>
    </header>
    <main id="main">
      <div class="col" id="left" aria-label="Case">
        <section class="card steps" id="p-steps"></section>
        <section class="card queue" id="p-queue"></section>
        <section class="card builton" id="p-builton">
          <h2>Built on</h2>
          <div class="sponsor"><b>ZooWork</b><span>Five managed agents (history, logistics, identity, forensics, critic), each with custom tools over the evidence vault.</span></div>
          <div class="sponsor"><b>Band</b><span>The critic opens a room and @mentions the specialists; their replies route back through the room. Remove Band and the coordination breaks.</span></div>
          <div class="sponsor"><b>Entire</b><span>Every commit of this build carries its Claude Code session, so the work itself is auditable.</span></div>
          <div class="sponsor rail"><b>Stripe</b><span>Payments rail, test mode: disputes are created, evidence staged and submitted for real.</span></div>
        </section>
        <section class="card case" id="p-case" hidden></section>
        <div id="p-verdict"></div>
        <div id="p-routing"></div>
        <div id="p-stripe"></div>
      </div>
      <section id="stage-card" aria-label="Evidence graph">
        <div id="stage"></div>
        <h2 class="overlay stage-title">Evidence graph<small id="s-sub">Every customer and order. Drag to orbit, scroll to zoom, click a node to focus.</small></h2>
        <div class="overlay legend" id="s-legend" aria-label="Legend"></div>
      </section>
      <aside class="col" id="right" aria-label="Agents and transcript">
        <section class="card outline">
          <h2>Investigation <small id="p-room">ZooWork agents, coordinated in Band</small></h2>
          <div class="agents" id="p-agents"></div>
        </section>
        <section class="card transcript-card collapsed" id="p-transcript-card">
          <h2>Transcript <small id="p-count"></small><button class="ghost small" id="b-transcript">Show</button></h2>
          <div class="transcript" id="p-transcript" aria-live="polite" aria-relevant="additions"></div>
          <button class="jump" id="p-jump">Jump to latest</button>
        </section>
      </aside>
    </main>
    <div id="toasts" role="status" aria-live="polite"></div>`

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
  const el = {
    merchant: $('t-merchant'),
    chips: $('t-chips'),
    status: $('t-status'),
    auto: $<HTMLInputElement>('b-auto'),
    replay: $<HTMLButtonElement>('b-replay'),
    reset: $<HTMLButtonElement>('b-reset'),
    steps: $('p-steps'),
    queue: $('p-queue'),
    builton: $('p-builton'),
    case: $('p-case'),
    verdict: $('p-verdict'),
    routing: $('p-routing'),
    stripe: $('p-stripe'),
    stage: $('stage'),
    sub: $('s-sub'),
    legend: $('s-legend'),
    room: $('p-room'),
    agents: $('p-agents'),
    count: $('p-count'),
    transcriptCard: $('p-transcript-card'),
    transcriptToggle: $<HTMLButtonElement>('b-transcript'),
    transcript: $('p-transcript'),
    jump: $<HTMLButtonElement>('p-jump'),
    toasts: $('toasts'),
  }

  el.legend.innerHTML =
    `<div><i style="background:#CBD5E1"></i>Customer</div>` +
    (['human', 'signed', 'declared', 'undeclared-suspected'] as const).map((k) => `<div><i style="background:${POPULATION[k].color}"></i>Order, ${POPULATION[k].label.toLowerCase()}</div>`).join('') +
    `<div><i class="ring" style="--pink:${POPULATION.cluster.color}"></i>Agent sandbox (Muse, Dots)</div>` +
    `<div><i class="ring" style="--pink:#EF4444"></i>Flagged order</div>` +
    `<div><i style="background:#EF4444"></i>Dispute</div>` +
    `<div><i class="torus"></i>Return</div>` +
    `<div><i class="leaf"></i>Device, address, card or evidence</div>`

  el.replay.addEventListener('click', () => handlers.onReplay())
  el.reset.addEventListener('click', () => handlers.onReset())
  el.auto.addEventListener('change', () => handlers.onAutoRun(el.auto.checked))
  el.queue.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-case]')
    if (!btn || btn.disabled) return
    btn.disabled = true
    window.setTimeout(() => (btn.disabled = false), 4000)
    handlers.onOpenCase(btn.dataset.case ?? '')
  })
  // Approve and submit: a two-click confirm instead of a modal.
  let confirmTimer = 0
  let submitWatchdog = 0
  /** Put a 'Submitting' button back to its armed-less state so a failed submit can be retried. */
  function resetSubmit() {
    window.clearTimeout(submitWatchdog)
    const btn = el.stripe.querySelector<HTMLButtonElement>('button[data-submit]')
    if (!btn || !btn.disabled) return
    btn.disabled = false
    btn.dataset.armed = '0'
    btn.textContent = 'Approve and submit to Stripe'
    btn.classList.remove('armed')
  }
  el.stripe.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-submit]')
    if (!btn || btn.disabled) return
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1'
      btn.textContent = 'Confirm: submit to Stripe'
      btn.classList.add('armed')
      window.clearTimeout(confirmTimer)
      confirmTimer = window.setTimeout(() => {
        btn.dataset.armed = '0'
        btn.textContent = 'Approve and submit to Stripe'
        btn.classList.remove('armed')
      }, 6000)
      return
    }
    window.clearTimeout(confirmTimer)
    btn.disabled = true
    btn.textContent = 'Submitting'
    handlers.onSubmit(btn.dataset.submit ?? '')
    // A successful submit re-renders the card from a `stripe.submitted` event; a failed one only
    // toasts an error (which resets the button) or hangs, so a watchdog restores it either way.
    submitWatchdog = window.setTimeout(resetSubmit, 30_000)
  })
  el.transcriptToggle.addEventListener('click', () => {
    const collapsed = el.transcriptCard.classList.toggle('collapsed')
    el.transcriptToggle.textContent = collapsed ? 'Show' : 'Hide'
    if (!collapsed) el.transcript.scrollTop = el.transcript.scrollHeight
  })

  let stickToBottom = true
  const nearBottom = () => el.transcript.scrollTop + el.transcript.clientHeight >= el.transcript.scrollHeight - 24
  el.transcript.addEventListener('scroll', () => {
    stickToBottom = nearBottom()
    el.jump.classList.toggle('show', !stickToBottom)
  })
  el.jump.addEventListener('click', () => {
    stickToBottom = true
    el.transcript.scrollTop = el.transcript.scrollHeight
    el.jump.classList.remove('show')
  })

  let stats: Stats | null = null
  let queue: QueueItem[] = []
  let mode: PanelMode = 'idle'
  let connLabel = 'connecting'
  let connOk = false
  let renderedTranscriptId = 0
  let renderedCaseId: string | null = null
  let lastCaseKey = ''
  let lastQueueKey = ''
  let lastStep = -1
  let lastOutlineKey = ''
  let verdictKey = ''
  let routingKey = ''
  let stripeKey = ''
  let caseDueBy: string | null = null
  let stripeDueBy: string | null = null
  let lastState: State | null = null

  function renderStats() {
    const v = stats?.vamp
    if (!v) {
      el.chips.innerHTML = ''
      return
    }
    const ratio = v.ratio ?? 0
    const threshold = v.threshold ?? 0.015
    const headroom = v.headroom_items ?? 0
    const warn = ratio >= threshold * 0.85
    el.chips.innerHTML =
      `<span class="chip${warn ? ' warn' : ''}" title="(TC40 + TC15) / TC05 for ${esc(v.window ?? 'the window')}, threshold ${pct(threshold, 1)}">VAMP <b>${pct(ratio)}</b></span>` +
      `<span class="chip${headroom <= 8 ? ' warn' : ''}" title="Disputes left before the ${pct(threshold, 1)} threshold">Headroom <b>${esc(headroom)} items</b></span>` +
      (stats?.orders ? `<span class="chip">Orders <b>${esc(stats.orders)}</b></span>` : '')
  }

  function renderStatus() {
    const cls = mode === 'live' ? 'live' : mode === 'replay' ? 'replay' : connOk ? 'live' : 'off'
    el.status.className = `status ${cls}`
    const text = mode === 'live' ? 'Live case' : mode === 'replay' ? 'Demo replay' : connLabel === 'live' ? 'Connected' : connLabel
    el.status.querySelector('span')!.textContent = text
    el.replay.classList.toggle('active', mode === 'replay')
  }

  function renderSteps(s: State) {
    const step = stepOf(s)
    if (step === lastStep) return
    lastStep = step
    el.steps.innerHTML =
      `<ol class="stepper">${STEPS.map((st, i) => `<li class="${i < step ? 'done' : i === step ? 'current' : ''}"><i>${i + 1}</i><span>${esc(st.title)}</span></li>`).join('')}</ol>` +
      `<p class="step-hint">${esc(STEPS[step].hint)}</p>`
  }

  function renderQueue(s: State) {
    const show = !s.case
    el.queue.hidden = !show
    el.builton.hidden = !show
    if (!show) return
    const key = queue.map((q) => `${q.id}:${q.case?.status ?? ''}:${q.case?.tier ?? ''}`).join('|') + `:${s.activeCaseId ?? ''}`
    if (key === lastQueueKey) return
    lastQueueKey = key
    const open = queue.filter((q) => q.case?.status !== 'decided')
    const decided = queue.filter((q) => q.case?.status === 'decided')
    const running = queue.find((q) => q.case?.status === 'running')
    const row = (q: QueueItem) => {
      const p = populationOf(q.population)
      const status = q.case?.status === 'running' ? `<span class="pill thinking">running</span>` : q.case?.status === 'decided' ? `<span class="pill done">${esc(words(q.case.tier ?? 'decided'))}</span>` : `<span class="pill">new</span>`
      const risk = q.flags.filter((f) => f !== 'established_low_risk').length
      const blocked = Boolean(running && running.id !== q.id)
      return `<button class="qrow" data-case="${esc(q.id)}" title="${esc(q.statement)}"${blocked ? ' disabled' : ''}>
        <span class="qkind ${q.kind}">${q.kind === 'dispute' ? (q.inquiry ? 'Inquiry' : 'Chargeback') : 'Return claim'}</span>
        <span class="qmain"><b>${esc(q.title)}</b><span>${esc(q.customer_name)}${q.hero ? ', demo case' : ''}</span></span>
        <span class="qmeta"><b class="num">${money(q.amount)}</b><span class="num">${esc(dueShort(q.due_by))}</span></span>
        <span class="qtags"><i title="${esc(p.label)}" style="background:${p.color}"></i>${risk ? `<em>${risk} flag${risk === 1 ? '' : 's'}</em>` : ''}${status}</span>
      </button>`
    }
    el.queue.innerHTML =
      `<h2>Queue <small>${open.length} open, ${decided.length} decided</small></h2>` +
      (running ? `<div class="hint running-hint">One case at a time. ${esc(running.customer_name)}'s case is running; wait for it to finish or press Esc.</div>` : '') +
      (queue.length ? `<div class="qlist">${open.map(row).join('')}${decided.length ? `<div class="qsep">Decided</div>${decided.map(row).join('')}` : ''}</div>` : `<div class="hint">Loading the queue</div>`)
  }

  function renderCase(s: State) {
    const c = s.case
    el.case.hidden = !c
    if (!c) {
      caseDueBy = null
      lastCaseKey = ''
      return
    }
    const key = `${c.case_id}:${c.closed}:${c.flags.length}:${c.population}`
    caseDueBy = c.due_by
    if (key === lastCaseKey) return
    lastCaseKey = key
    el.case.className = `card case${c.closed ? ' closed' : ''}`
    el.case.innerHTML =
      `<h2>${c.kind === 'dispute' ? 'Chargeback' : 'Return claim'} <small>${esc(c.case_id)}</small></h2>` +
      `<div class="title">${esc(c.title)}</div>` +
      `<div class="amount-row"><span class="hero">${money(c.amount)}</span>${populationBadge(c.population)}</div>` +
      `<div class="sub">${esc(c.customer_name)}, order ${esc(c.order_id)}</div>` +
      (c.summary ? `<div class="summary">${esc(c.summary)}</div>` : '') +
      (c.flags.length ? `<div class="flags">${c.flags.map((f) => `<span class="flag">${esc(words(f))}</span>`).join('')}</div>` : '') +
      (c.due_by ? `<div class="due"><span>Response due</span><b id="p-case-due" class="num"></b></div>` : '')
    renderCountdowns()
  }

  function renderOutline(s: State) {
    // Keyed on what the outline shows, not on `seq`: rebuilding per event replays the fade-in.
    const key = [
      s.case?.case_id ?? '',
      s.case?.room?.title ?? '',
      ...AGENT_NAMES.map((n) => `${s.agents[n].joined}:${s.agents[n].status}:${s.agents[n].detail ?? ''}`),
      s.evidence.map((e) => `${e.id}:${e.agent ?? ''}`).join(','),
      s.verdict ? `${s.verdict.tier}:${s.verdict.rationale}` : '',
    ].join('|')
    if (key === lastOutlineKey) return
    lastOutlineKey = key
    el.agents.innerHTML = AGENT_NAMES.map((name) => {
      const a = s.agents[name]
      const meta = AGENT_META[name]
      let pill = 'standby'
      let cls = 'standby'
      if (a.joined) {
        switch (a.status) {
          case 'thinking':
            pill = name === 'critic' ? 'weighing evidence' : 'investigating'
            cls = 'thinking'
            break
          case 'tool':
            pill = `tool: ${toolName(a.detail)}`
            cls = 'tool'
            break
          case 'posting':
            pill = 'posting'
            cls = 'posting'
            break
          case 'done':
            pill = 'done'
            cls = 'done'
            break
          case 'error':
            pill = 'fell back'
            cls = 'error'
            break
          default:
            pill = 'idle'
            cls = 'idle'
        }
      }
      const findings = s.evidence.filter((e) => e.agent === name)
      const body =
        name === 'critic' && s.verdict
          ? `<div class="finding verdict-line"><span class="sev" style="background:${(TIER_TINT[s.verdict.tier] ?? { bg: '#F1F5F9' }).bg};color:${(TIER_TINT[s.verdict.tier] ?? { fg: '#334155' }).fg}">${esc(words(s.verdict.tier))}</span><span>${esc(s.verdict.rationale.split(/(?<=\.)\s/)[0])}</span></div>`
          : findings
              .map((e) => {
                const sev = severityOf(e.severity)
                return `<div class="finding"><span class="sev" style="background:${sev.bg};color:${sev.fg}">${sev.label}</span><span>${esc(e.label)}</span></div>`
              })
              .join('')
      const quiet = !a.joined && !s.case
      return `<div class="agent ${cls}${quiet ? ' standby' : ''}">
        <div class="agent-row"><i style="background:${AGENT_COLOR[name]}"></i><b>${esc(meta.title)}</b><small>${esc(meta.brief)}</small>${a.joined && a.via ? `<span class="via ${a.via}">${a.via === 'band' ? 'via Band' : 'in-process'}</span>` : ''}<span class="pill ${cls}">${esc(pill)}</span></div>
        ${body ? `<div class="findings">${body}</div>` : ''}
      </div>`
    }).join('')
    el.room.textContent = s.case?.room ? `ZooWork agents in Band room "${s.case.room.title}"` : 'ZooWork agents, coordinated in Band'
  }

  function renderTranscript(s: State) {
    const caseId = s.case?.case_id ?? null
    if (caseId !== renderedCaseId || s.transcript.length === 0) {
      el.transcript.innerHTML = ''
      renderedTranscriptId = 0
      renderedCaseId = caseId
      stickToBottom = true
      el.jump.classList.remove('show')
    }
    if (!s.transcript.length) {
      el.count.textContent = ''
      return
    }
    const fresh = s.transcript.filter((l) => l.id > renderedTranscriptId)
    if (fresh.length) {
      const frag = document.createDocumentFragment()
      for (const l of fresh) {
        const div = document.createElement('div')
        div.className = `line ${l.kind}`
        const who = l.agent ? `<span class="who" style="color:${agentColor(l.agent)}">${esc(AGENT_META[l.agent].title)}</span>` : ''
        div.innerHTML = `<i style="background:${l.kind === 'system' ? 'transparent' : agentColor(l.agent)}"></i><div>${who}<span class="${l.kind === 'message' ? 'm' : ''}">${withMentions(l.text)}</span></div>`
        frag.appendChild(div)
      }
      el.transcript.appendChild(frag)
      renderedTranscriptId = s.transcript[s.transcript.length - 1].id
      while (el.transcript.childElementCount > 400) el.transcript.removeChild(el.transcript.firstElementChild!)
      if (stickToBottom) el.transcript.scrollTop = el.transcript.scrollHeight
      else el.jump.classList.add('show')
    }
    const msgs = s.transcript.filter((l) => l.kind === 'message').length
    el.count.textContent = `${msgs} message${msgs === 1 ? '' : 's'}`
  }

  function renderCards(s: State) {
    const v = s.verdict
    const vk = v ? `${s.case?.case_id}:${v.tier}:${v.confidence}` : ''
    if (vk !== verdictKey) {
      verdictKey = vk
      if (v) {
        const tint = TIER_TINT[v.tier] ?? { bg: '#F1F5F9', fg: '#334155', border: '#E2E8F0' }
        el.verdict.innerHTML = `<section class="card verdict" style="--tint-bg:${tint.bg};--tint-fg:${tint.fg};--tint-border:${tint.border}"><h2>Verdict <small>${v.evidence_ids.length} findings weighed</small></h2><div class="hero">${esc(words(v.tier))}</div><div class="conf"><span>Confidence</span><div class="meter"><b style="transform:scaleX(${Math.max(0, Math.min(1, v.confidence)).toFixed(3)})"></b></div><b class="num" style="color:var(--text)">${pct(v.confidence, 0)}</b></div><p>${esc(v.rationale)}</p>${v.policy_citation ? `<div class="cite">${esc(v.policy_citation)}</div>` : ''}</section>`
      } else el.verdict.innerHTML = ''
    }

    const r = s.routing
    const rk = r ? `${s.case?.case_id}:${r.decision}:${r.expected_recovery}` : ''
    if (rk !== routingKey) {
      routingKey = rk
      if (r) {
        const tint = ROUTING_TINT[r.decision] ?? { bg: '#F1F5F9', fg: '#334155' }
        el.routing.innerHTML = `<section class="card routing"><h2>Dispute routing <small>${esc(r.dispute_id)}</small></h2><div class="hero"><span class="decision" style="background:${tint.bg};color:${tint.fg}">${esc(words(r.decision))}</span></div><div class="kv"><div><b class="num">${pct(r.vamp.ratio_before)}<span class="arrow">to</span>${pct(r.vamp.ratio_after)}</b><span>VAMP before and after</span></div><div><b class="num">${pct(r.vamp.threshold, 1)}</b><span>Visa threshold</span></div><div><b class="num">${money(r.expected_recovery)}</b><span>Expected recovery</span></div></div><p>${esc(r.rationale)}</p></section>`
      } else el.routing.innerHTML = ''
    }

    const p = s.stripe
    const pk = p ? `${s.case?.case_id}:${p.dispute_id}:${Object.keys(p.evidence).length}:${p.submitted}:${p.submitted_status ?? ''}` : ''
    if (pk !== stripeKey) {
      stripeKey = pk
      stripeDueBy = p?.due_by ?? null
      if (p) {
        const fields = Object.entries(p.evidence)
        const status = p.submitted
          ? `<div class="staged submitted">Submitted to Stripe${p.submitted_status ? `, ${esc(words(p.submitted_status))}` : ''}</div>`
          : `<div class="staged">Staged, not submitted</div>`
        const action = !p.submitted && p.stripe_dispute_id && s.case
          ? `<button class="primary" data-submit="${esc(s.case.case_id)}">Approve and submit to Stripe</button>`
          : !p.submitted && !p.stripe_dispute_id
            ? `<div class="hint">Staged locally; Stripe test mode was unavailable for this case.</div>`
            : ''
        el.stripe.innerHTML = `<section class="card stripe"><h2>Evidence package <small>staged in Stripe test mode, ${esc(p.stripe_dispute_id ?? p.dispute_id)}</small></h2>${status}<div class="countdown"><span>${fields.length} field${fields.length === 1 ? '' : 's'}, due ${esc(new Date(p.due_by).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</span><b id="p-stripe-due"></b></div>${action ? `<div class="approve">${action}</div>` : ''}<div class="fields">${fields.map(([k, val]) => `<div><span title="${esc(k)}">${esc(words(k))}</span><em title="${esc(val)}">${esc(val)}</em></div>`).join('')}</div>${p.dashboard_url ? `<div class="link"><a href="${esc(p.dashboard_url)}" target="_blank" rel="noreferrer">Open in the Stripe dashboard</a></div>` : ''}</section>`
      } else el.stripe.innerHTML = ''
    }
    renderCountdowns()
  }

  function renderCountdowns() {
    const tick = (id: string, due: string | null) => {
      const node = root.querySelector<HTMLElement>(`#${id}`)
      if (!node || !due) return
      const ms = new Date(due).getTime() - Date.now()
      node.textContent = formatCountdown(ms)
      node.classList.toggle('urgent', ms < 86_400_000)
    }
    tick('p-case-due', caseDueBy)
    tick('p-stripe-due', stripeDueBy)
  }

  const countdownTimer = window.setInterval(renderCountdowns, 1000)

  function render(s: State) {
    lastState = s
    try {
      el.merchant.textContent = s.merchant ?? 'Harbor & Pine Outfitters'
      renderSteps(s)
      renderQueue(s)
      renderCase(s)
      renderOutline(s)
      renderTranscript(s)
      renderCards(s)
      el.reset.hidden = !s.case && mode !== 'replay'
      el.sub.textContent = s.case
        ? `Focused on ${s.case.customer_name}'s order ${s.case.order_id}. ${s.evidence.length} finding${s.evidence.length === 1 ? '' : 's'} attached so far.`
        : 'Every customer and order. Drag to orbit, scroll to zoom, click a node to focus.'
    } catch (err) {
      console.warn('[panel] render failed', err)
    }
  }

  return {
    stage: el.stage,
    render,
    setStats(next) {
      stats = next
      renderStats()
    },
    setQueue(items) {
      queue = items
      lastQueueKey = ''
      if (lastState) renderQueue(lastState)
    },
    setAutoRun(enabled) {
      el.auto.checked = enabled
    },
    setConnection(label, ok) {
      connLabel = label
      connOk = ok
      renderStatus()
    },
    setMode(m) {
      mode = m
      renderStatus()
      if (lastState) el.reset.hidden = !lastState.case && mode !== 'replay'
    },
    toast(message, kind = 'info') {
      if (kind === 'error') resetSubmit()
      const t = document.createElement('div')
      t.className = `toast ${kind}`
      t.textContent = message
      el.toasts.appendChild(t)
      window.setTimeout(() => t.remove(), 3800)
    },
    destroy() {
      window.clearInterval(countdownTimer)
      root.innerHTML = ''
    },
  }
}
