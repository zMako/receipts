import { loadDataset, VaultBuilder, type Dataset, type EvidenceVault } from '@receipts/seed'

export const data: Dataset = loadDataset()
export const vaults = new VaultBuilder(data)
const cache = new Map<string, EvidenceVault>()

export function vaultFor(orderId: string): EvidenceVault | undefined {
  const hit = cache.get(orderId)
  if (hit) return hit
  const v = vaults.build(orderId)
  if (v) cache.set(orderId, v)
  return v
}

export function allVaults(): EvidenceVault[] {
  return data.orders.map((o) => vaultFor(o.id)!)
}

export interface GraphNode {
  id: string
  type: 'customer' | 'order' | 'device' | 'address' | 'payment' | 'return' | 'dispute'
  label: string
  population?: string
  flags?: string[]
  amount?: number
  at?: string
}
export interface GraphEdge {
  source: string
  target: string
  type: 'placed' | 'used_device' | 'shipped_to' | 'paid_with' | 'returned' | 'disputed'
}

let graphCache: { nodes: GraphNode[]; edges: GraphEdge[] } | null = null
export function graph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (graphCache) return graphCache
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const put = (n: GraphNode) => nodes.has(n.id) || nodes.set(n.id, n)
  for (const c of data.customers) put({ id: c.id, type: 'customer', label: c.name, at: c.account_created_at })
  for (const v of allVaults()) {
    const o = data.orders.find((x) => x.id === v.order_id)!
    put({ id: o.id, type: 'order', label: o.id, population: v.population, flags: v.flags, amount: o.total, at: o.placed_at })
    edges.push({ source: o.customer_id, target: o.id, type: 'placed' })
    const dev = data.devices.find((d) => d.id === o.session.device_id)
    if (dev) {
      put({ id: dev.id, type: 'device', label: dev.cluster ? `${dev.cluster}` : `${dev.browser} / ${dev.platform}`, population: dev.cluster ? 'cluster' : undefined })
      edges.push({ source: o.id, target: dev.id, type: 'used_device' })
    }
    const addr = data.addresses.find((a) => a.id === o.shipping_address_id)
    if (addr) {
      put({ id: addr.id, type: 'address', label: `${addr.line1}, ${addr.city}` })
      edges.push({ source: o.id, target: addr.id, type: 'shipped_to' })
    }
    const payId = o.payment.kind === 'card' ? `pay_${o.payment.bin}_${o.payment.last4}` : o.payment.id
    put({ id: payId, type: 'payment', label: `${o.payment.kind} •••• ${o.payment.last4}` })
    edges.push({ source: o.id, target: payId, type: 'paid_with' })
    for (const r of v.returns) {
      put({ id: r.id, type: 'return', label: `${r.kind}: ${r.reason}`, amount: r.amount, at: r.requested_at, flags: [...r.photo_findings, ...r.claim_findings] })
      edges.push({ source: o.id, target: r.id, type: 'returned' })
    }
    for (const d of v.disputes) {
      put({ id: d.id, type: 'dispute', label: `${d.network} ${d.reason_code} ${d.reason}`, amount: d.amount, at: d.created_at })
      edges.push({ source: o.id, target: d.id, type: 'disputed' })
    }
  }
  graphCache = { nodes: [...nodes.values()], edges }
  return graphCache
}
