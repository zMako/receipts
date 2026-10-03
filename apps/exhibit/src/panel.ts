/**
 * Product shell: top bar, left column (case / verdict / routing / Stripe), centre stage card for the
 * graph, right column (agent roster + transcript) and toasts. Plain DOM, no framework.
 * `render(state)` is called after every event (not per frame); countdowns tick on their own timer.
 */
import { AGENT_META, AGENT_NAMES, type AgentName } from './contract'
import type { State, TranscriptLine } from './state'
import { AGENT_COLOR, POPULATION, ROUTING_TINT, TIER_TINT, populationOf, severityOf } from './theme'

export interface Stats {
  orders?: number
  customers?: number
  returns?: number
  disputes?: number
  by_population?: Record<string, number>
  vamp?: { ratio?: number; threshold?: number; headroom_items?: number; tc05?: number; tc40?: number; tc15?: number; window?: string }
}

export type PanelMode = 'idle' | 'replay' | 'live'

export interface PanelHandlers {
  onReplay(): void
  onLive(): void
  onReset(): void
  /** Open one of the hero cases live. `id` is a dispute (dp_*) or return (ret_*) id. */
  onOpenCase(id: string): void
}

export interface Panel {
  /** Container the three.js scene renders into (inside the centre card). */
  readonly stage: HTMLElement
  render(state: State): void
  setStats(stats: Stats | null): void
  setConnection(label: string, ok: boolean): void
  setMode(mode: PanelMode): void
  toast(message: string, kind?: 'info' | 'warn' | 'error'): void
  destroy(): void
}

export const HERO_CASES: { id: string; title: string; brief: string; color: string }[] = [
  { id: 'dp_doubledip', title: 'Double dip chargeback', brief: 'Refunded on first scan, then disputed as "my agent did it"', color: POPULATION['undeclared-suspected'].color },
  { id: 'ret_aiphoto', title: 'AI-photo damage claim', brief: 'Synthetic photos, policy-lawyer claim text', color: POPULATION.human.color },
  { id: 'ret_loyal_defect', title: 'Loyal customer, real defect', brief: 'Six-year customer, genuine seam failure', color: POPULATION.signed.color },
  { id: 'dp_signed', title: 'Signed agent dispute', brief: 'Web Bot Auth signature on file, cardholder denies', color: POPULATION.declared.color },
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

export function createPanel(root: HTMLElement, handlers: PanelHandlers): Panel {
  root.innerHTML = `
    <header id="topbar">
      <h1 class="wordmark"><i aria-hidden="true"></i>Receipts</h1>
      <div class="sep" aria-hidden="true"></div>
      <div class="merchant" id="t-merchant"></div>
      <div class="chips" id="t-chips"></div>
      <div class="spacer"></div>
      <div class="actions">
        <button class="ghost" id="b-replay" aria-keyshortcuts="R">Replay<kbd aria-hidden="true">R</kbd></button>
        <button class="ghost" id="b-live" aria-keyshortcuts="L">Run live<kbd aria-hidden="true">L</kbd></button>
        <button class="ghost" id="b-reset" aria-keyshortcuts="Escape">Reset<kbd aria-hidden="true">Esc</kbd></button>
        <div class="status" id="t-status" role="status" aria-live="polite"><i aria-hidden="true"></i><span>connecting</span></div>
      </div>
    </header>
    <main id="main">
      <div class="col" id="left" aria-label="Case">
        <section class="card case" id="p-case"></section>
        <div id="p-verdict"></div>
        <div id="p-routing"></div>
        <div id="p-stripe"></div>
      </div>
      <section id="stage-card" aria-label="Evidence graph">
        <div id="stage"></div>
        <h2 class="overlay stage-title">Evidence graph<small id="s-sub">Drag to orbit, scroll to zoom, click a node to focus</small></h2>
        <div class="overlay legend" id="s-legend" aria-label="Legend"></div>
      </section>
      <aside class="col" id="right" aria-label="Agents and transcript">
        <section class="card">
          <h2>Agents <small id="p-room"></small></h2>
          <div class="agents" id="p-agents"></div>
        </section>
        <section class="card transcript-card">
          <h2>Transcript <small id="p-count"></small></h2>
          <div class="transcript" id="p-transcript" aria-live="polite" aria-relevant="additions"><div class="empty">Waiting for agents</div></div>
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
    replay: $<HTMLButtonElement>('b-replay'),
    live: $<HTMLButtonElement>('b-live'),
    reset: $<HTMLButtonElement>('b-reset'),
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
    transcript: $('p-transcript'),
    jump: $<HTMLButtonElement>('p-jump'),
    toasts: $('toasts'),
  }

  el.legend.innerHTML =
    (['human', 'signed', 'declared', 'undeclared-suspected'] as const).map((k) => `<div><i style="background:${POPULATION[k].color}"></i>${POPULATION[k].label}</div>`).join('') +
    `<div><i class="ring" style="--pink:${POPULATION.cluster.color}"></i>${POPULATION.cluster.label}</div>` +
    `<div><i style="background:#CBD5E1"></i>Customer</div>`

  el.replay.addEventListener('click', () => handlers.onReplay())
  el.live.addEventListener('click', () => handlers.onLive())
  el.reset.addEventListener('click', () => handlers.onReset())
  el.case.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-case]')
    if (!btn || btn.disabled) return
    btn.disabled = true
    window.setTimeout(() => (btn.disabled = false), 4000)
    handlers.onOpenCase(btn.dataset.case ?? '')
  })

  // Transcript auto-scroll with a "jump to latest" affordance when the reader has scrolled up.
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
  let mode: PanelMode = 'idle'
  let connLabel = 'connecting'
  let connOk = false
  let renderedTranscriptId = 0
  let renderedCaseId: string | null = null
  let caseEmptyRendered = false
  let lastCaseKey = ''
  let verdictKey = ''
  let routingKey = ''
  let stripeKey = ''
  let caseDueBy: string | null = null
  let stripeDueBy: string | null = null

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
    const text = mode === 'live' ? 'Live case' : mode === 'replay' ? 'Replay' : connLabel === 'live' ? 'Connected' : connLabel
    el.status.querySelector('span')!.textContent = text
    el.replay.classList.toggle('active', mode === 'replay')
    el.live.classList.toggle('active', mode === 'live')
  }

  function renderCase(s: State) {
    const c = s.case
    if (!c) {
      caseDueBy = null
      if (caseEmptyRendered && lastCaseKey === `empty:${s.activeCaseId ?? ''}`) return
      caseEmptyRendered = true
      lastCaseKey = `empty:${s.activeCaseId ?? ''}`
      el.case.className = 'card case empty-state'
      el.case.innerHTML =
        `<h2>Case</h2>` +
        `<div class="lead">No open case</div>` +
        `<div class="hint">${s.activeCaseId ? `Live case <b>${esc(s.activeCaseId)}</b> is open on the server; waiting for its events.` : 'Open a hero case to start a live war room, or press <b>R</b> for the offline replay.'}</div>` +
        `<div class="heroes">${HERO_CASES.map((h) => `<button class="hero-btn" data-case="${esc(h.id)}"><div><b>${esc(h.title)}</b><span>${esc(h.brief)}</span></div><code>${esc(h.id)}</code></button>`).join('')}</div>`
      return
    }
    caseEmptyRendered = false
    const key = `${c.case_id}:${c.closed}:${c.flags.length}:${c.population}`
    caseDueBy = c.due_by
    if (key === lastCaseKey) return
    lastCaseKey = key
    el.case.className = `card case${c.closed ? ' closed' : ''}`
    el.case.innerHTML =
      `<h2>${c.kind === 'dispute' ? 'Dispute' : 'Return'} <small>${esc(c.case_id)}</small></h2>` +
      `<div class="title">${esc(c.title)}</div>` +
      `<div class="amount-row"><span class="hero">${money(c.amount)}</span>${populationBadge(c.population)}</div>` +
      `<div class="sub">${esc(c.customer_name)}, order ${esc(c.order_id)}</div>` +
      (c.summary ? `<div class="summary">${esc(c.summary)}</div>` : '') +
      (c.flags.length ? `<div class="flags">${c.flags.map((f) => `<span class="flag">${esc(words(f))}</span>`).join('')}</div>` : '') +
      (c.due_by ? `<div class="due"><span>Response due</span><b id="p-case-due" class="num"></b></div>` : '')
    renderCountdowns()
  }

  function renderAgents(s: State) {
    el.agents.innerHTML = AGENT_NAMES.map((name) => {
      const a = s.agents[name]
      const meta = AGENT_META[name]
      let pill: string
      let cls: string
      if (!a.joined) {
        pill = 'standby'
        cls = 'standby'
      } else {
        switch (a.status) {
          case 'thinking':
            pill = 'investigating'
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
            pill = 'error'
            cls = 'error'
            break
          default:
            pill = 'idle'
            cls = 'idle'
        }
      }
      return `<div class="agent${a.joined ? '' : ' standby'}" title="${esc(meta.brief)}${a.detail ? `. ${esc(a.detail)}` : ''}"><i style="background:${AGENT_COLOR[name]}"></i><div><b>${esc(meta.title)}</b>${a.evidenceCount ? `<small>${a.evidenceCount} evidence</small>` : ''}</div><span class="pill ${cls}">${esc(pill)}</span></div>`
    }).join('')
    el.room.textContent = s.case?.room ? s.case.room.title : ''
  }

  function evidenceForLine(s: State, l: TranscriptLine) {
    if (l.kind !== 'status' || !l.text.startsWith('attached ')) return null
    return s.evidence.find((e) => l.text.endsWith(`evidence: ${e.label ?? e.id}`)) ?? null
  }

  function evidenceCard(s: State, l: TranscriptLine, ev: NonNullable<ReturnType<typeof evidenceForLine>>): string {
    const sev = severityOf(ev.severity)
    const w = Math.max(-1, Math.min(1, Number(ev.weight) || 0))
    const bar = w >= 0 ? `left:50%;width:${(w * 50).toFixed(1)}%;background:${sev.color}` : `right:50%;width:${(-w * 50).toFixed(1)}%;background:${severityOf('exculpatory').color}`
    const by = l.agent ? `<span class="by" style="color:${agentColor(l.agent)}">${esc(AGENT_META[l.agent].title)}</span>` : ''
    return `<div class="ev"><div class="top"><span class="sev" style="background:${sev.bg};color:${sev.fg}">${sev.label}</span><span class="lbl">${esc(ev.label)}</span>${by}</div><div class="detail">${esc(ev.detail)}</div><div class="w"><span>weight</span><div class="bar"><s></s><b style="${bar}"></b></div><span>${w >= 0 ? '+' : ''}${w.toFixed(2)}</span></div></div>`
  }

  function renderTranscript(s: State) {
    const caseId = s.case?.case_id ?? null
    if (caseId !== renderedCaseId || s.transcript.length === 0 || (s.transcript[0] && s.transcript[0].id > renderedTranscriptId + 1 && renderedTranscriptId === 0)) {
      el.transcript.innerHTML = s.transcript.length ? '' : '<div class="empty">Waiting for agents</div>'
      renderedTranscriptId = 0
      renderedCaseId = caseId
      stickToBottom = true
      el.jump.classList.remove('show')
    }
    if (!s.transcript.length) {
      el.count.textContent = ''
      return
    }
    if (renderedTranscriptId === 0) el.transcript.innerHTML = ''
    const fresh = s.transcript.filter((l) => l.id > renderedTranscriptId)
    if (fresh.length) {
      const frag = document.createDocumentFragment()
      for (const l of fresh) {
        const ev = evidenceForLine(s, l)
        const div = document.createElement('div')
        if (ev) {
          div.innerHTML = evidenceCard(s, l, ev)
          frag.appendChild(div.firstElementChild!)
          continue
        }
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
    el.count.textContent = `${msgs} message${msgs === 1 ? '' : 's'}, ${s.evidence.length} evidence item${s.evidence.length === 1 ? '' : 's'}`
  }

  function renderCards(s: State) {
    const v = s.verdict
    const vk = v ? `${s.case?.case_id}:${v.tier}:${v.confidence}` : ''
    if (vk !== verdictKey) {
      verdictKey = vk
      if (v) {
        const tint = TIER_TINT[v.tier] ?? { bg: '#F1F5F9', fg: '#334155', border: '#E2E8F0' }
        el.verdict.innerHTML = `<section class="card verdict" style="--tint-bg:${tint.bg};--tint-fg:${tint.fg};--tint-border:${tint.border}"><h2>Verdict <small>${v.evidence_ids.length} evidence items</small></h2><div class="hero">${esc(words(v.tier))}</div><div class="conf"><span>Confidence</span><div class="meter"><b style="transform:scaleX(${Math.max(0, Math.min(1, v.confidence)).toFixed(3)})"></b></div><b class="num" style="color:var(--text)">${pct(v.confidence, 0)}</b><span>Abuse score ${v.score.toFixed(2)}</span></div><p>${esc(v.rationale)}</p>${v.policy_citation ? `<div class="cite">${esc(v.policy_citation)}</div>` : ''}</section>`
      } else el.verdict.innerHTML = ''
    }

    const r = s.routing
    const rk = r ? `${s.case?.case_id}:${r.decision}:${r.expected_recovery}` : ''
    if (rk !== routingKey) {
      routingKey = rk
      if (r) {
        const tint = ROUTING_TINT[r.decision] ?? { bg: '#F1F5F9', fg: '#334155' }
        el.routing.innerHTML = `<section class="card routing"><h2>Routing <small>${esc(r.dispute_id)}</small></h2><div class="hero"><span class="decision" style="background:${tint.bg};color:${tint.fg}">${esc(words(r.decision))}</span></div><div class="kv"><div><b class="num">${pct(r.vamp.ratio_before)}<span class="arrow">to</span>${pct(r.vamp.ratio_after)}</b><span>VAMP before and after</span></div><div><b class="num">${pct(r.vamp.threshold, 1)}</b><span>Threshold</span></div><div><b class="num">${money(r.expected_recovery)}</b><span>Expected recovery</span></div></div><p>${esc(r.rationale)}</p></section>`
      } else el.routing.innerHTML = ''
    }

    const p = s.stripe
    const pk = p ? `${s.case?.case_id}:${p.dispute_id}:${Object.keys(p.evidence).length}` : ''
    if (pk !== stripeKey) {
      stripeKey = pk
      stripeDueBy = p?.due_by ?? null
      if (p) {
        const fields = Object.entries(p.evidence)
        el.stripe.innerHTML = `<section class="card stripe"><h2>Stripe representment <small>${esc(p.stripe_dispute_id ?? p.dispute_id)}</small></h2><div class="staged">Staged, not submitted</div><div class="countdown"><span>${fields.length} field${fields.length === 1 ? '' : 's'}, due ${esc(new Date(p.due_by).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</span><b id="p-stripe-due"></b></div><div class="fields">${fields.map(([k, val]) => `<div><span title="${esc(k)}">${esc(k)}</span><em title="${esc(val)}">${esc(val)}</em></div>`).join('')}</div>${p.dashboard_url ? `<div class="link"><a href="${esc(p.dashboard_url)}" target="_blank" rel="noreferrer">Open in Stripe dashboard</a></div>` : ''}</section>`
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
    try {
      el.merchant.textContent = s.merchant ?? 'Harbor & Pine Outfitters'
      renderCase(s)
      renderAgents(s)
      renderTranscript(s)
      renderCards(s)
      el.sub.textContent = s.case ? `${s.case.customer_name}, order ${s.case.order_id}, ${s.evidence.length} evidence item${s.evidence.length === 1 ? '' : 's'}` : 'Drag to orbit, scroll to zoom, click a node to focus'
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
    setConnection(label, ok) {
      connLabel = label
      connOk = ok
      renderStatus()
    },
    setMode(m) {
      mode = m
      renderStatus()
    },
    toast(message, kind = 'info') {
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
