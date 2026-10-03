/**
 * Node inspector: a small card in the corner of the graph that shows what a merchant would want to
 * know about a node at a glance, without opening a case. Orders and customers fetch their data from
 * the server; shared devices, addresses and cards show what the graph already knows.
 */
import { API } from './contract'
import type { GNode, State } from './state'
import { populationOf } from './theme'

export interface InspectorHandlers {
  onOpenCase(id: string): void
  onFocus(nodeId: string): void
}

interface EvidenceVaultLite {
  order_id: string
  customer_id: string
  customer_name: string
  placed_at: string
  total: number
  lines: { name: string; size?: string; color?: string; qty: number; unit_price: number }[]
  population: string
  population_score: number
  population_signals: { signal: string; detail: string; weight: number }[]
  ce3: { eligible: boolean; qualifying_transactions: number; reason: string }
  delivery: { carrier: string; delivered_at: string | null; proof_of_delivery: string | null; delivery_address_match: boolean }
  payment: { kind: string; brand: string; last4: string; name_matches_account: boolean }
  customer_history: { account_age_days: number; orders: number; returns: number; inr_claims: number; damage_claims: number; return_rate: number; refund_ratio: number }
  linkage: { shared_device_customers: string[]; shared_address_customers: string[]; shared_payment_customers: string[] }
  returns: { id: string; kind: string; reason: string; status: string; amount: number; refund: { amount: number; trigger: string } | null }[]
  disputes: { id: string; reason: string; reason_code: string; status: string; amount: number; evidence_due_by: string }[]
  flags: string[]
}

interface CustomerLite {
  customer: { id: string; name: string; email: string; account_created_at: string; tags: string[] }
  history: EvidenceVaultLite['customer_history']
  orders: { order_id: string; placed_at: string; total: number; population: string; flags: string[]; returns: unknown[]; disputes: unknown[] }[]
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

const money = (n: number) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const words = (s: string) => String(s ?? '').replace(/_/g, ' ')
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '')

function flagChips(flags: string[]): string {
  const shown = flags.filter((f) => f !== 'established_low_risk')
  return shown.length ? `<div class="i-flags">${shown.map((f) => `<span class="flag">${esc(words(f))}</span>`).join('')}</div>` : ''
}

export function createInspector(host: HTMLElement, handlers: InspectorHandlers) {
  const el = document.createElement('aside')
  el.className = 'inspector'
  el.hidden = true
  el.setAttribute('aria-label', 'Node details')
  host.appendChild(el)

  let current: string | null = null
  let token = 0

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-close]')) return hide()
    const open = t.closest<HTMLElement>('[data-open-case]')
    if (open) return handlers.onOpenCase(open.dataset.openCase ?? '')
    const focus = t.closest<HTMLElement>('[data-focus]')
    if (focus) return handlers.onFocus(focus.dataset.focus ?? '')
  })

  function frame(kind: string, title: string, body: string, actions = ''): string {
    return `<div class="i-head"><span class="i-kind">${esc(kind)}</span><button class="ghost small" data-close aria-label="Close">Close</button></div><div class="i-title">${title}</div>${body}${actions ? `<div class="i-actions">${actions}</div>` : ''}`
  }

  function hide() {
    el.hidden = true
    current = null
  }

  async function show(node: GNode, state: State) {
    current = node.id
    const my = ++token
    el.hidden = false
    el.innerHTML = frame(node.type, esc(node.label), `<div class="i-muted">Loading</div>`)
    try {
      if (node.type === 'order') {
        const res = await fetch(API.evidence(node.id))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const v = (await res.json()) as EvidenceVaultLite
        if (my !== token) return
        const pop = populationOf(v.population)
        const openDispute = v.disputes.find((d) => d.status === 'needs_response' || d.status === 'warning_needs_response')
        const openReturn = v.returns.find((r) => r.status === 'requested' || (r.status === 'received' && !r.refund))
        const h = v.customer_history
        const body =
          `<div class="i-row"><b class="num">${money(v.total)}</b><span class="badge"><i style="background:${pop.color}"></i>${esc(pop.label)}</span></div>` +
          `<div class="i-muted">${esc(v.customer_name)}, placed ${day(v.placed_at)}. ${v.lines.map((l) => `${l.name}${l.size ? ' ' + l.size : ''}${l.color ? ' ' + l.color : ''}${l.qty > 1 ? ' x' + l.qty : ''}`).join('; ')}</div>` +
          `<dl class="i-dl">` +
          `<dt>Delivery</dt><dd>${v.delivery.delivered_at ? `${v.delivery.carrier}, ${day(v.delivery.delivered_at)}, ${v.delivery.proof_of_delivery} proof${v.delivery.delivery_address_match ? '' : ', address mismatch'}` : 'not delivered'}</dd>` +
          `<dt>Payment</dt><dd>${esc(words(v.payment.kind))} ${esc(v.payment.brand)} ${esc(v.payment.last4)}${v.payment.name_matches_account ? '' : ', name mismatch'}</dd>` +
          `<dt>Customer</dt><dd>${h.orders} order${h.orders === 1 ? '' : 's'}, ${Math.round(h.return_rate * 100)}% returns, ${h.account_age_days} days old</dd>` +
          `<dt>CE 3.0</dt><dd>${v.ce3.eligible ? `eligible, ${v.ce3.qualifying_transactions} prior transactions` : 'not eligible'}</dd>` +
          (v.population !== 'human' && v.population_signals.length ? `<dt>Signals</dt><dd>${v.population_signals.slice(0, 3).map((s) => esc(words(s.signal))).join(', ')}</dd>` : '') +
          (v.returns.length ? `<dt>Returns</dt><dd>${v.returns.map((r) => `${esc(words(r.kind))} ${esc(words(r.reason))}, ${esc(r.status)}${r.refund ? `, refunded ${money(r.refund.amount)}` : ''}`).join('; ')}</dd>` : '') +
          (v.disputes.length ? `<dt>Disputes</dt><dd>${v.disputes.map((d) => `${esc(d.reason_code)} ${esc(words(d.reason))}, ${esc(words(d.status))}, due ${day(d.evidence_due_by)}`).join('; ')}</dd>` : '') +
          `</dl>` +
          flagChips(v.flags)
        const target = openDispute?.id ?? openReturn?.id
        const alreadyOpen = state.case && state.case.order_id === v.order_id && !state.case.closed
        const actions =
          `<button class="ghost small" data-focus="${esc(v.customer_id)}">Show customer</button>` +
          (target && !alreadyOpen ? `<button class="primary small" data-open-case="${esc(target)}">Open as case</button>` : '')
        el.innerHTML = frame('Order', `${esc(v.order_id)}`, body, actions)
        return
      }
      if (node.type === 'customer') {
        const res = await fetch(`/api/customers/${encodeURIComponent(node.id)}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const c = (await res.json()) as CustomerLite
        if (my !== token) return
        const h = c.history
        const flagged = c.orders.filter((o) => o.flags.some((f) => f !== 'established_low_risk'))
        const agentOrders = c.orders.filter((o) => o.population !== 'human')
        const body =
          `<div class="i-muted">${esc(c.customer.email)}, since ${day(c.customer.account_created_at)}${c.customer.tags.length ? ', ' + esc(c.customer.tags.join(', ')) : ''}</div>` +
          `<dl class="i-dl">` +
          `<dt>Orders</dt><dd>${h.orders}, ${money(c.orders.reduce((s, o) => s + o.total, 0))} total</dd>` +
          `<dt>Returns</dt><dd>${h.returns} return${h.returns === 1 ? '' : 's'}, ${h.inr_claims} not-received, ${h.damage_claims} damage claim${h.damage_claims === 1 ? '' : 's'} (${Math.round(h.return_rate * 100)}%)</dd>` +
          `<dt>Refunds</dt><dd>${Math.round(h.refund_ratio * 100)}% of order value</dd>` +
          (agentOrders.length ? `<dt>Agents</dt><dd>${agentOrders.length} order${agentOrders.length === 1 ? '' : 's'} placed by shopping agents</dd>` : '') +
          `</dl>` +
          flagChips([...new Set(flagged.flatMap((o) => o.flags))])
        const openOrder = c.orders.find((o) => (o.disputes as unknown[]).length || (o.returns as unknown[]).length)
        const actions = openOrder ? `<button class="ghost small" data-focus="${esc(openOrder.order_id)}">Show latest claim</button>` : ''
        el.innerHTML = frame('Customer', esc(c.customer.name), body, actions)
        return
      }
      // Devices, addresses, cards, returns, disputes: what the graph knows.
      const edges = state.graph.edges.filter((e) => e.target === node.id || e.source === node.id)
      const orders = edges.map((e) => (e.target === node.id ? e.source : e.target)).filter((id) => state.graph.byId[id]?.type === 'order')
      const customers = new Set<string>()
      for (const oid of orders) for (const e of state.graph.edges) if (e.target === oid && e.type === 'placed') customers.add(e.source)
      const kind = node.type === 'device' ? (node.population === 'cluster' ? 'Agent sandbox' : 'Device') : node.type === 'address' ? 'Address' : node.type === 'payment' ? 'Card' : node.type === 'return' ? 'Return' : node.type === 'dispute' ? 'Dispute' : 'Evidence'
      const body =
        `<dl class="i-dl">` +
        (orders.length ? `<dt>Orders</dt><dd>${orders.length}</dd>` : '') +
        (customers.size ? `<dt>Accounts</dt><dd>${customers.size} ${customers.size === 1 ? 'account uses it' : 'different accounts share it'}</dd>` : '') +
        (node.population === 'cluster' ? `<dt>Meaning</dt><dd>One browser image shared by every session of this shopping agent. It identifies the agent, not the customer, so it cannot serve as device evidence.</dd>` : '') +
        (node.amount ? `<dt>Amount</dt><dd>${money(node.amount)}</dd>` : '') +
        `</dl>` +
        flagChips(node.flags ?? [])
      const first = orders[0]
      el.innerHTML = frame(kind, esc(node.label), body, first ? `<button class="ghost small" data-focus="${esc(first)}">Show an order</button>` : '')
    } catch (err) {
      if (my !== token) return
      el.innerHTML = frame(node.type, esc(node.label), `<div class="i-muted">Could not load details: ${esc((err as Error).message)}</div>`)
    }
  }

  return {
    show,
    hide,
    get current() {
      return current
    },
  }
}
