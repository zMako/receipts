/**
 * Side panel, bottom ticker and toasts. Plain DOM, no framework. `render(state)` is called after
 * every event (not per frame); the countdown has its own one-second timer.
 */
import { AGENT_META, AGENT_NAMES, POPULATION_COLOR, POPULATION_LABEL, SEVERITY_COLOR, type AgentName } from './contract'
import type { State } from './state'

export const PANEL_WIDTH = 380

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
}

export interface Panel {
  render(state: State): void
  setStats(stats: Stats | null): void
  setConnection(label: string, ok: boolean): void
  setMode(mode: PanelMode): void
  toast(message: string, kind?: 'info' | 'warn' | 'error'): void
  destroy(): void
}

const CSS = `
:root{--panel-w:${PANEL_WIDTH}px;--bg:rgba(10,12,20,.72);--line:rgba(255,255,255,.08);--fg:#e8eaf2;--muted:#9aa3b5;--accent:#7dd3fc}
#panel{position:fixed;top:0;right:0;bottom:48px;width:var(--panel-w);display:flex;flex-direction:column;background:var(--bg);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);border-left:1px solid var(--line);color:var(--fg);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;z-index:10;box-shadow:-20px 0 60px rgba(0,0,0,.35)}
#panel *{box-sizing:border-box}
#panel .hdr{padding:18px 18px 12px;border-bottom:1px solid var(--line)}
#panel .brand{display:flex;align-items:center;justify-content:space-between;gap:10px}
#panel .brand h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:#fff}
#panel .brand .conn{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
#panel .conn i{width:8px;height:8px;border-radius:50%;background:#64748b;display:inline-block}
#panel .conn.ok i{background:#4ade80;box-shadow:0 0 8px #4ade80}
#panel .merchant{margin-top:4px;font-size:16px;color:#fff}
#panel .stats{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
#panel .stat{flex:1 1 90px;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0}
#panel .stat b{display:block;font-size:18px;font-weight:600;color:#fff;font-variant-numeric:tabular-nums}
#panel .stat span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
#panel .stat.warn b{color:#fbbf24}
#panel .case{margin-top:12px;padding:12px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid var(--line)}
#panel .case.empty{color:var(--muted)}
#panel .case .title{font-size:15px;font-weight:600;color:#fff}
#panel .case .meta{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}
#panel .case .amount{font-size:20px;font-weight:600;color:#fff;font-variant-numeric:tabular-nums}
#panel .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.02em;border:1px solid currentColor}
#panel .case .summary{margin-top:8px;color:#cfd4e0;font-size:13px}
#panel .case .flags{margin-top:6px;display:flex;gap:4px;flex-wrap:wrap}
#panel .flag{font-size:11px;padding:1px 6px;border-radius:4px;background:rgba(248,113,113,.14);color:#fca5a5}
#panel .body{flex:1;overflow:auto;padding:0 18px 18px;scroll-behavior:smooth}
#panel .body::-webkit-scrollbar{width:8px}#panel .body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:4px}
#panel h2{font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin:18px 0 8px;font-weight:600;display:flex;justify-content:space-between;align-items:center}
#panel h2 small{letter-spacing:0;text-transform:none;font-weight:400}
#panel .agents{display:grid;grid-template-columns:repeat(5,1fr);gap:6px}
#panel .agent{text-align:center;padding:8px 2px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid var(--line);opacity:.45;transition:opacity .3s}
#panel .agent.joined{opacity:1}
#panel .agent i{display:block;width:12px;height:12px;border-radius:50%;margin:0 auto 5px;box-shadow:0 0 0 0 transparent;transition:box-shadow .3s}
#panel .agent.joined i{box-shadow:0 0 10px currentColor}
#panel .agent b{display:block;font-size:11px;font-weight:600;color:#fff}
#panel .agent span{display:block;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#panel .agent.tool i,#panel .agent.thinking i{animation:pulse 1s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.5)}}
#panel .transcript{height:230px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:rgba(0,0,0,.25);padding:8px 10px}
#panel .transcript::-webkit-scrollbar{width:6px}#panel .transcript::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}
#panel .line{display:flex;gap:8px;padding:4px 0;font-size:13px;animation:fade .3s ease-out}
@keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
#panel .line i{flex:none;width:10px;height:10px;border-radius:50%;margin-top:5px;background:#64748b}
#panel .line .who{font-weight:600;color:#fff;margin-right:5px}
#panel .line.status{color:var(--muted);font-size:12px}
#panel .line.status .who{color:var(--muted)}
#panel .line.system{color:#cbd5e1;font-style:italic}
#panel .line.system i{background:transparent;border:1px solid #64748b}
#panel .line .m{color:#fff}
#panel .line .mention{color:var(--accent)}
#panel .empty{color:var(--muted);font-size:13px;padding:6px 0}
#panel .ev{padding:8px 0;border-bottom:1px solid var(--line);animation:fade .3s}
#panel .ev:last-child{border-bottom:0}
#panel .ev .top{display:flex;align-items:center;gap:8px}
#panel .ev .chip{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:2px 7px;border-radius:999px;color:#05060a}
#panel .ev .lbl{font-weight:600;color:#fff;flex:1}
#panel .ev .who{font-size:11px;color:var(--muted)}
#panel .ev .detail{font-size:12px;color:#b8c0d0;margin-top:3px}
#panel .bar{height:4px;border-radius:2px;background:rgba(255,255,255,.08);margin-top:6px;position:relative;overflow:hidden}
#panel .bar s{position:absolute;top:0;bottom:0;left:50%;width:1px;background:rgba(255,255,255,.25)}
#panel .bar b{position:absolute;top:0;bottom:0;border-radius:2px}
#panel .card{border-radius:12px;padding:14px;background:rgba(255,255,255,.05);border:1px solid var(--line);animation:fade .4s}
#panel .card.verdict{border-color:rgba(74,222,128,.35);background:linear-gradient(180deg,rgba(74,222,128,.10),rgba(255,255,255,.03))}
#panel .card.verdict.decline{border-color:rgba(248,113,113,.4);background:linear-gradient(180deg,rgba(248,113,113,.12),rgba(255,255,255,.03))}
#panel .card .tier{font-size:22px;font-weight:700;color:#fff;letter-spacing:-.01em}
#panel .card .sub{color:var(--muted);font-size:12px;margin-top:2px}
#panel .card p{margin:8px 0 0;font-size:13px;color:#d6dbe6}
#panel .card .cite{margin-top:8px;font-size:12px;color:var(--muted);border-left:2px solid rgba(255,255,255,.2);padding-left:8px}
#panel .kv{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;margin-top:10px}
#panel .kv div{background:rgba(0,0,0,.25);border-radius:8px;padding:6px 8px}
#panel .kv b{display:block;font-size:15px;color:#fff;font-variant-numeric:tabular-nums}
#panel .kv span{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
#panel .fields{margin-top:10px;font-size:12px}
#panel .fields div{padding:4px 0;border-bottom:1px solid var(--line);display:grid;grid-template-columns:120px 1fr;gap:8px}
#panel .fields div:last-child{border:0}
#panel .fields span{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}
#panel .fields em{font-style:normal;color:#d6dbe6}
#panel .staged{display:inline-flex;align-items:center;gap:6px;margin-top:4px;font-size:12px;color:#fbbf24}
#panel .staged i{width:8px;height:8px;border-radius:50%;background:#fbbf24;display:inline-block;box-shadow:0 0 8px #fbbf24}
#panel .countdown{font-size:22px;font-weight:600;color:#fff;font-variant-numeric:tabular-nums;margin-top:8px}
#panel .countdown.urgent{color:#f87171}
#panel .actions{display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--line);background:rgba(0,0,0,.2)}
#panel button{flex:1;appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;border-radius:8px;padding:10px 8px;font:600 13px system-ui,sans-serif;cursor:pointer;transition:background .15s,border-color .15s}
#panel button:hover{background:rgba(255,255,255,.12)}
#panel button.primary{background:rgba(125,211,252,.18);border-color:rgba(125,211,252,.45)}
#panel button.primary:hover{background:rgba(125,211,252,.3)}
#panel button.danger:hover{background:rgba(248,113,113,.2);border-color:rgba(248,113,113,.5)}
#panel button[disabled]{opacity:.5;cursor:default}
#panel button kbd{font:inherit;opacity:.55;margin-left:4px}
#ticker{position:fixed;left:0;right:0;bottom:0;height:48px;display:flex;align-items:center;gap:14px;padding:0 20px;background:rgba(6,8,14,.82);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--line);color:#e8eaf2;font:15px system-ui,sans-serif;z-index:11;white-space:nowrap;overflow:hidden}
#ticker .tag{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
#ticker i{width:10px;height:10px;border-radius:50%;background:#64748b;flex:none}
#ticker .txt{overflow:hidden;text-overflow:ellipsis;flex:1}
#ticker .txt b{color:#fff}
#ticker .chip{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:2px 7px;border-radius:999px;color:#05060a;flex:none}
#ticker .idle{color:var(--muted)}
#toasts{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:20;display:flex;flex-direction:column;gap:8px;pointer-events:none}
#toasts .toast{background:rgba(15,18,28,.92);border:1px solid rgba(255,255,255,.14);color:#fff;padding:10px 16px;border-radius:10px;font:14px system-ui,sans-serif;animation:fade .25s;box-shadow:0 10px 30px rgba(0,0,0,.4)}
#toasts .toast.warn{border-color:rgba(251,191,36,.5)}#toasts .toast.error{border-color:rgba(248,113,113,.6)}
#legend{position:fixed;left:18px;bottom:62px;z-index:9;display:flex;flex-direction:column;gap:6px;color:#cbd5e1;font:12px system-ui,sans-serif;pointer-events:none}
#legend div{display:flex;align-items:center;gap:8px}
#legend i{width:10px;height:10px;border-radius:50%;display:inline-block;box-shadow:0 0 8px currentColor}
#legend .t{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9aa3b5;margin-bottom:2px}
#hint{position:fixed;left:18px;top:18px;z-index:9;color:#fff;font:600 13px system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;opacity:.85;pointer-events:none}
#hint small{display:block;font-weight:400;letter-spacing:0;text-transform:none;color:#9aa3b5;margin-top:4px;font-size:13px}
@media (max-width:900px){#panel{width:100%;bottom:48px}#legend,#hint{display:none}}
`

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

function money(n: number): string {
  return `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function pct(n: number, digits = 2): string {
  return `${((Number(n) || 0) * 100).toFixed(digits)}%`
}

export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (ms <= 0) return 'overdue'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (x: number) => String(x).padStart(2, '0')
  return d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m ${pad(sec)}s` : `${pad(h)}:${pad(m)}:${pad(sec)}`
}

function agentDot(agent: AgentName | undefined): string {
  const color = agent ? AGENT_META[agent]?.color ?? '#64748b' : '#64748b'
  return `<i style="background:${color};box-shadow:0 0 6px ${color}"></i>`
}

function withMentions(text: string): string {
  return esc(text).replace(/@(history|logistics|identity|forensics|critic)\b/g, (_m, a: AgentName) => `<span class="mention" style="color:${AGENT_META[a].color}">@${a}</span>`)
}

function populationBadge(pop: string | undefined): string {
  const key = (pop ?? '') as keyof typeof POPULATION_COLOR
  const color = POPULATION_COLOR[key] ?? '#94a3b8'
  const label = POPULATION_LABEL[key] ?? pop ?? 'unknown'
  return `<span class="badge" style="color:${color}">${esc(label)}</span>`
}

export function createPanel(root: HTMLElement, handlers: PanelHandlers): Panel {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const panel = document.createElement('aside')
  panel.id = 'panel'
  panel.innerHTML = `
    <div class="hdr">
      <div class="brand"><h1>Receipts</h1><div class="conn" id="p-conn"><i></i><span>connecting</span></div></div>
      <div class="merchant" id="p-merchant">—</div>
      <div class="stats" id="p-stats"></div>
      <div class="case empty" id="p-case">No case open. The exhibit replays the double-dip war room on load; press <b>R</b> to run it again.</div>
    </div>
    <div class="body" id="p-body">
      <h2>War room <small id="p-room"></small></h2>
      <div class="agents" id="p-agents"></div>
      <h2>Transcript <small id="p-count"></small></h2>
      <div class="transcript" id="p-transcript"><div class="empty">Waiting for agents…</div></div>
      <h2>Evidence <small id="p-evcount"></small></h2>
      <div id="p-evidence"><div class="empty">Nothing attached yet.</div></div>
      <div id="p-verdict"></div>
      <div id="p-routing"></div>
      <div id="p-stripe"></div>
    </div>
    <div class="actions">
      <button class="primary" id="b-replay">Replay (offline)<kbd>R</kbd></button>
      <button id="b-live">Run live<kbd>L</kbd></button>
      <button class="danger" id="b-reset">Reset<kbd>Esc</kbd></button>
    </div>`
  root.appendChild(panel)

  const ticker = document.createElement('div')
  ticker.id = 'ticker'
  ticker.innerHTML = `<span class="tag">Latest evidence</span><i></i><span class="txt idle">Receipts · agent-era evidence vault and dispute war room</span>`
  root.appendChild(ticker)

  const toasts = document.createElement('div')
  toasts.id = 'toasts'
  root.appendChild(toasts)

  const legend = document.createElement('div')
  legend.id = 'legend'
  legend.innerHTML =
    `<div class="t">Orders by population</div>` +
    (['human', 'signed', 'declared', 'undeclared-suspected', 'cluster'] as const).map((k) => `<div><i style="color:${POPULATION_COLOR[k]};background:${POPULATION_COLOR[k]}"></i>${POPULATION_LABEL[k]}</div>`).join('') +
    `<div class="t" style="margin-top:6px">Agents</div>` +
    AGENT_NAMES.map((a) => `<div><i style="color:${AGENT_META[a].color};background:${AGENT_META[a].color}"></i>${AGENT_META[a].title}</div>`).join('')
  root.appendChild(legend)

  const hint = document.createElement('div')
  hint.id = 'hint'
  hint.innerHTML = `Evidence graph<small>Drag to orbit · scroll to zoom · R replay · L live · Esc reset</small>`
  root.appendChild(hint)

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => panel.querySelector<T>(`#${id}`)!
  const el = {
    conn: $('p-conn'),
    merchant: $('p-merchant'),
    stats: $('p-stats'),
    case: $('p-case'),
    body: $('p-body'),
    room: $('p-room'),
    agents: $('p-agents'),
    count: $('p-count'),
    transcript: $('p-transcript'),
    evcount: $('p-evcount'),
    evidence: $('p-evidence'),
    verdict: $('p-verdict'),
    routing: $('p-routing'),
    stripe: $('p-stripe'),
    replay: $<HTMLButtonElement>('b-replay'),
    live: $<HTMLButtonElement>('b-live'),
    reset: $<HTMLButtonElement>('b-reset'),
  }

  el.replay.addEventListener('click', () => handlers.onReplay())
  el.live.addEventListener('click', () => handlers.onLive())
  el.reset.addEventListener('click', () => handlers.onReset())

  let stats: Stats | null = null
  let last: State | null = null
  let renderedTranscriptId = 0
  let renderedCaseId: string | null = null
  let evidenceCount = -1
  let verdictShown = false
  let routingShown = false
  let stripeShown = false
  let dueBy: string | null = null

  function renderStats() {
    const v = stats?.vamp
    if (!v) {
      el.stats.innerHTML = ''
      return
    }
    const ratio = v.ratio ?? 0
    const threshold = v.threshold ?? 0.015
    const headroom = v.headroom_items ?? 0
    const warn = ratio >= threshold * 0.85
    el.stats.innerHTML =
      `<div class="stat${warn ? ' warn' : ''}" title="(TC40 + TC15) / TC05 for ${esc(v.window ?? 'the window')}"><b>${pct(ratio)}</b><span>VAMP ratio</span></div>` +
      `<div class="stat"><b>${pct(threshold, 1)}</b><span>Threshold</span></div>` +
      `<div class="stat${headroom <= 8 ? ' warn' : ''}"><b>${esc(headroom)}</b><span>Headroom</span></div>` +
      (stats?.orders ? `<div class="stat"><b>${esc(stats.orders)}</b><span>Orders</span></div>` : '')
  }

  function renderCase(s: State) {
    const c = s.case
    if (!c) {
      el.case.className = 'case empty'
      el.case.innerHTML = s.activeCaseId
        ? `Live case <b>${esc(s.activeCaseId)}</b> is open on the server; waiting for its events.`
        : 'No case open. The exhibit replays the double-dip war room on load; press <b>R</b> to run it again.'
      return
    }
    el.case.className = 'case'
    el.case.innerHTML =
      `<div class="title">${esc(c.title)}</div>` +
      `<div class="meta"><span class="amount">${money(c.amount)}</span>${populationBadge(c.population)}<span style="color:var(--muted);font-size:12px">${esc(c.customer_name)} · ${esc(c.kind)}${c.closed ? ' · closed' : ''}</span></div>` +
      (c.summary ? `<div class="summary">${esc(c.summary)}</div>` : '') +
      (c.flags.length ? `<div class="flags">${c.flags.map((f) => `<span class="flag">${esc(f.replace(/_/g, ' '))}</span>`).join('')}</div>` : '')
  }

  function renderAgents(s: State) {
    el.agents.innerHTML = AGENT_NAMES.map((name) => {
      const a = s.agents[name]
      const meta = AGENT_META[name]
      const status = !a.joined ? 'standby' : a.status === 'idle' ? 'in room' : a.status
      return `<div class="agent ${a.joined ? 'joined' : ''} ${a.status}" title="${esc(meta.brief)}${a.detail ? ` — ${esc(a.detail)}` : ''}"><i style="background:${meta.color};color:${meta.color}"></i><b>${meta.title}</b><span>${esc(status)}${a.evidenceCount ? ` · ${a.evidenceCount}` : ''}</span></div>`
    }).join('')
    el.room.textContent = s.case?.room ? s.case.room.title : ''
  }

  function renderTranscript(s: State) {
    if (s.case?.case_id !== renderedCaseId || s.transcript.length === 0 || (s.transcript[0] && s.transcript[0].id > renderedTranscriptId + 1 && renderedTranscriptId === 0)) {
      el.transcript.innerHTML = s.transcript.length ? '' : '<div class="empty">Waiting for agents…</div>'
      renderedTranscriptId = 0
      renderedCaseId = s.case?.case_id ?? null
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
        const div = document.createElement('div')
        div.className = `line ${l.kind}`
        const who = l.agent ? `<span class="who" style="color:${AGENT_META[l.agent].color}">${AGENT_META[l.agent].title}</span>` : ''
        div.innerHTML = `${agentDot(l.agent)}<div>${who}<span class="${l.kind === 'message' ? 'm' : ''}">${withMentions(l.text)}</span></div>`
        frag.appendChild(div)
      }
      el.transcript.appendChild(frag)
      renderedTranscriptId = s.transcript[s.transcript.length - 1].id
      while (el.transcript.childElementCount > 400) el.transcript.removeChild(el.transcript.firstElementChild!)
      el.transcript.scrollTop = el.transcript.scrollHeight
    }
    el.count.textContent = `${s.transcript.filter((l) => l.kind === 'message').length} messages`
  }

  function renderEvidence(s: State) {
    if (s.evidence.length === evidenceCount && s.case?.case_id === renderedCaseId) return
    evidenceCount = s.evidence.length
    el.evcount.textContent = s.evidence.length ? `${s.evidence.length} items · net ${s.evidence.reduce((a, e) => a + (Number(e.weight) || 0), 0).toFixed(2)}` : ''
    if (!s.evidence.length) {
      el.evidence.innerHTML = '<div class="empty">Nothing attached yet.</div>'
      return
    }
    el.evidence.innerHTML = s.evidence
      .map((e) => {
        const sev = SEVERITY_COLOR[e.severity as keyof typeof SEVERITY_COLOR] ?? '#94a3b8'
        const w = Math.max(-1, Math.min(1, Number(e.weight) || 0))
        const bar = w >= 0 ? `left:50%;width:${(w * 50).toFixed(1)}%;background:${sev}` : `right:50%;width:${(-w * 50).toFixed(1)}%;background:${SEVERITY_COLOR.exculpatory}`
        const by = findAttachingAgent(s, e.id)
        return `<div class="ev"><div class="top"><span class="chip" style="background:${sev}">${esc(e.severity)}</span><span class="lbl">${esc(e.label)}</span>${by ? `<span class="who" style="color:${AGENT_META[by].color}">${AGENT_META[by].title}</span>` : ''}</div><div class="detail">${esc(e.detail)}</div><div class="bar" title="weight ${w.toFixed(2)}"><s></s><b style="${bar}"></b></div></div>`
      })
      .join('')
  }

  function findAttachingAgent(s: State, evidenceId: string): AgentName | undefined {
    // The transcript status line carries the agent for each attach; cheap reverse lookup.
    const ev = s.evidence.find((e) => e.id === evidenceId)
    if (!ev) return undefined
    const l = [...s.transcript].reverse().find((t) => t.kind === 'status' && t.text.endsWith(`evidence: ${ev.label}`))
    return l?.agent
  }

  function renderCards(s: State) {
    const v = s.verdict
    el.verdict.innerHTML = v
      ? `<h2>Verdict</h2><div class="card verdict ${esc(v.tier)}"><div class="tier">${esc(v.tier.replace(/_/g, ' '))}</div><div class="sub">confidence ${pct(v.confidence, 0)} · abuse score ${v.score.toFixed(2)} · ${v.evidence_ids.length} evidence items</div><p>${esc(v.rationale)}</p>${v.policy_citation ? `<div class="cite">${esc(v.policy_citation)}</div>` : ''}</div>`
      : ''
    const r = s.routing
    el.routing.innerHTML = r
      ? `<h2>Dispute routing</h2><div class="card"><div class="tier" style="font-size:18px">${esc(r.decision.replace(/_/g, ' '))}</div><div class="sub">${esc(r.dispute_id)}</div><div class="kv"><div><b>${pct(r.vamp.ratio_before)}</b><span>VAMP before</span></div><div><b>${pct(r.vamp.ratio_after)}</b><span>VAMP after</span></div><div><b>${pct(r.vamp.threshold, 1)}</b><span>Threshold</span></div><div><b>${money(r.expected_recovery)}</b><span>Expected recovery</span></div></div><p>${esc(r.rationale)}</p></div>`
      : ''
    const p = s.stripe
    el.stripe.innerHTML = p
      ? `<h2>Stripe representment</h2><div class="card"><div class="staged"><i></i>Staged, not submitted${p.stripe_dispute_id ? ` · ${esc(p.stripe_dispute_id)}` : ''}</div><div class="sub">Evidence due ${esc(new Date(p.due_by).toLocaleString())}</div><div class="countdown" id="p-countdown">—</div><div class="fields">${Object.entries(p.evidence)
          .map(([k, val]) => `<div><span>${esc(k)}</span><em>${esc(val)}</em></div>`)
          .join('')}</div>${p.dashboard_url ? `<p><a href="${esc(p.dashboard_url)}" target="_blank" rel="noreferrer" style="color:var(--accent)">Open in Stripe dashboard</a></p>` : ''}</div>`
      : ''
    dueBy = p?.due_by ?? s.case?.due_by ?? null
    renderCountdown()
    const reveal = (shown: boolean, present: boolean, node: HTMLElement) => {
      if (present && !shown) node.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      return present
    }
    verdictShown = reveal(verdictShown, !!v, el.verdict)
    routingShown = reveal(routingShown, !!r, el.routing)
    stripeShown = reveal(stripeShown, !!p, el.stripe)
  }

  function renderCountdown() {
    const node = panel.querySelector<HTMLElement>('#p-countdown')
    if (!node || !dueBy) return
    const ms = new Date(dueBy).getTime() - Date.now()
    node.textContent = `${formatCountdown(ms)} to respond`
    node.classList.toggle('urgent', ms < 86_400_000)
  }

  function renderTicker(s: State) {
    const txt = ticker.querySelector<HTMLElement>('.txt')!
    const dot = ticker.querySelector<HTMLElement>('i')!
    const e = s.evidence[s.evidence.length - 1]
    if (!e) {
      txt.className = 'txt idle'
      txt.innerHTML = s.case ? esc(s.case.title) : 'Receipts · agent-era evidence vault and dispute war room'
      dot.style.background = '#64748b'
      dot.style.boxShadow = 'none'
      ticker.querySelector('.chip')?.remove()
      return
    }
    const sev = SEVERITY_COLOR[e.severity as keyof typeof SEVERITY_COLOR] ?? '#94a3b8'
    const by = findAttachingAgent(s, e.id)
    const color = by ? AGENT_META[by].color : sev
    dot.style.background = color
    dot.style.boxShadow = `0 0 10px ${color}`
    txt.className = 'txt'
    txt.innerHTML = `<b>${esc(e.label)}</b> — ${esc(e.detail)}`
    let chip = ticker.querySelector<HTMLElement>('.chip')
    if (!chip) {
      chip = document.createElement('span')
      chip.className = 'chip'
      ticker.appendChild(chip)
    }
    chip.textContent = e.severity
    chip.style.background = sev
  }

  const countdownTimer = window.setInterval(renderCountdown, 1000)

  function render(s: State) {
    try {
      last = s
      el.merchant.textContent = s.merchant ?? 'Harbor & Pine Outfitters'
      renderCase(s)
      renderAgents(s)
      renderTranscript(s)
      renderEvidence(s)
      renderCards(s)
      renderTicker(s)
      if (!s.case) {
        verdictShown = routingShown = stripeShown = false
        evidenceCount = -1
      }
    } catch (err) {
      console.warn('[panel] render failed', err)
    }
  }

  return {
    render,
    setStats(next) {
      stats = next
      renderStats()
    },
    setConnection(label, ok) {
      el.conn.className = `conn${ok ? ' ok' : ''}`
      el.conn.querySelector('span')!.textContent = label
    },
    setMode(mode) {
      el.replay.innerHTML = mode === 'replay' ? 'Replaying…' : 'Replay (offline)<kbd>R</kbd>'
      el.live.innerHTML = mode === 'live' ? 'Live…' : 'Run live<kbd>L</kbd>'
      el.replay.classList.toggle('primary', mode !== 'live')
      el.live.classList.toggle('primary', mode === 'live')
    },
    toast(message, kind = 'info') {
      const t = document.createElement('div')
      t.className = `toast ${kind}`
      t.textContent = message
      toasts.appendChild(t)
      window.setTimeout(() => t.remove(), 3800)
    },
    destroy() {
      window.clearInterval(countdownTimer)
      panel.remove()
      ticker.remove()
      toasts.remove()
      legend.remove()
      hint.remove()
      style.remove()
      last = null
    },
  }
}
