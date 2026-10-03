import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Rng } from './rng.js'
import {
  AGENT_RUNTIME_DEVICE, CITIES, CLOUD_EGRESS_ASNS, FIRST_NAMES, HUMAN_DEVICES, LAST_NAMES, MERCHANT, MUSE_DEVICE,
  MUSE_UA, PRODUCTS, RESIDENTIAL_ASNS, SIGNED_AGENTS, STREETS,
} from './catalog.js'
import type {
  Address, AgentIdentity, ClaimPhoto, Customer, Dataset, Device, Dispute, Order, OrderLine, PaymentInstrument,
  Product, ReturnRequest, SessionTelemetry,
} from './types.js'

const rng = new Rng(20261003)
const NOW = new Date('2026-10-03T09:00:00-07:00')
const DAY = 86_400_000

const iso = (d: Date) => d.toISOString()
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY)
const addMin = (d: Date, n: number) => new Date(d.getTime() + n * 60_000)
const daysAgo = (n: number) => addDays(NOW, -n)
const round2 = (n: number) => Math.round(n * 100) / 100

const addresses: Address[] = []
const devices: Device[] = []
const customers: Customer[] = []
const orders: Order[] = []
const returns: ReturnRequest[] = []
const disputes: Dispute[] = []
const heroes: Record<string, string> = {}

let orderSeq = 1000
let returnSeq = 100
let disputeSeq = 10
const cardByCustomer = new Map<string, PaymentInstrument>()

function makeAddress(name: string, id?: string): Address {
  const c = rng.pick(CITIES)
  const a: Address = {
    id: id ?? `addr_${rng.hex(8)}`,
    name,
    line1: `${rng.int(12, 9800)} ${rng.pick(STREETS)}`,
    city: c.city,
    state: c.state,
    postal_code: c.zip,
    country: 'US',
  }
  addresses.push(a)
  return a
}

function makeDevice(kind: 'human' | 'muse' | 'agent', id?: string): Device {
  let d: Device
  if (kind === 'muse') {
    d = { id: id ?? `dev_${rng.hex(8)}`, fingerprint: 'fp_7c1e9a_linux-chrome131-swiftshader-2vcpu', ...MUSE_DEVICE, cluster: 'muse-sandbox' }
  } else if (kind === 'agent') {
    d = { id: id ?? `dev_${rng.hex(8)}`, fingerprint: `fp_agent_${rng.hex(6)}`, ...AGENT_RUNTIME_DEVICE, cluster: 'agent-runtime' }
  } else {
    d = { id: id ?? `dev_${rng.hex(8)}`, fingerprint: `fp_${rng.hex(12)}`, ...rng.pick(HUMAN_DEVICES) }
  }
  devices.push(d)
  return d
}

function makeCustomer(opts: { id?: string; createdDaysAgo: number; tags?: string[]; address?: Address; devices?: Device[]; name?: string }): Customer {
  const name = opts.name ?? `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`
  const id = opts.id ?? `cus_${rng.hex(10)}`
  const addr = opts.address ?? makeAddress(name)
  const devs = opts.devices ?? [makeDevice('human')]
  const c: Customer = {
    id,
    name,
    email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}${rng.int(1, 99)}@${rng.pick(['gmail.com', 'outlook.com', 'icloud.com', 'proton.me', 'yahoo.com'])}`,
    account_created_at: iso(daysAgo(opts.createdDaysAgo)),
    address_ids: [addr.id],
    device_ids: devs.map((d) => d.id),
    tags: opts.tags ?? [],
  }
  customers.push(c)
  return c
}

function cardFor(c: Customer): PaymentInstrument {
  let card = cardByCustomer.get(c.id)
  if (!card) {
    const brand = rng.pick(['visa', 'visa', 'mastercard', 'amex'] as const)
    card = { id: `pm_${rng.hex(8)}`, kind: 'card', brand, last4: String(rng.int(1000, 9999)), bin: brand === 'visa' ? '424242' : brand === 'mastercard' ? '555555' : '378282', name_on_card: c.name }
    cardByCustomer.set(c.id, card)
  }
  return card
}

function pickLines(count: number, fixed?: OrderLine[]): OrderLine[] {
  if (fixed) return fixed
  const lines: OrderLine[] = []
  for (let i = 0; i < count; i++) {
    const p = rng.pick(PRODUCTS)
    lines.push(line(p, { size: p.sizes ? rng.pick(p.sizes) : undefined, color: p.colors ? rng.pick(p.colors) : undefined, qty: rng.chance(0.15) ? 2 : 1 }))
  }
  return lines
}

function line(p: Product, o: { size?: string; color?: string; qty?: number }): OrderLine {
  return { sku: p.sku, name: p.name, size: o.size, color: o.color, qty: o.qty ?? 1, unit_price: p.price, weight_g: p.weight_g }
}

function session(kind: 'human' | 'muse' | 'signed' | 'declared', device: Device, agentOrigin?: string): SessionTelemetry {
  if (kind === 'human') {
    const a = rng.pick(RESIDENTIAL_ASNS)
    return { ip: `${a.prefix}${rng.int(1, 254)}.${rng.int(1, 254)}${a.prefix.endsWith('.') && a.prefix.split('.').length < 3 ? `.${rng.int(1, 254)}` : ''}`, asn: a.asn, asn_org: a.org, device_id: device.id, user_agent: `${device.browser} on ${device.platform}`, duration_s: rng.int(180, 1500), pages: rng.int(4, 20), hover_events: rng.int(20, 300), scroll_events: rng.int(10, 200), path: 'browse', checkout_ms: rng.int(45_000, 240_000) }
  }
  if (kind === 'muse') {
    const a = rng.pick(CLOUD_EGRESS_ASNS)
    return { ip: `${a.prefix}${rng.int(1, 254)}.${rng.int(1, 254)}`, asn: a.asn, asn_org: a.org, device_id: device.id, user_agent: MUSE_UA, duration_s: rng.int(25, 70), pages: rng.int(2, 4), hover_events: 0, scroll_events: 0, path: 'straight', checkout_ms: rng.int(2_000, 6_000) }
  }
  if (kind === 'declared') {
    return { ip: `20.${rng.int(1, 254)}.${rng.int(1, 254)}.${rng.int(1, 254)}`, asn: 8075, asn_org: 'Microsoft Azure', device_id: device.id, user_agent: 'Agent/Instinct (+https://instinct.shop/agent)', duration_s: rng.int(8, 30), pages: 2, hover_events: 0, scroll_events: 0, path: 'straight', checkout_ms: rng.int(900, 2_500) }
  }
  return { ip: `34.${rng.int(1, 254)}.${rng.int(1, 254)}.${rng.int(1, 254)}`, asn: 15169, asn_org: 'Google Cloud', device_id: device.id, user_agent: SIGNED_AGENTS.find((s) => s.origin === agentOrigin)?.ua ?? 'SignedAgent/1.0', duration_s: rng.int(4, 20), pages: 1, hover_events: 0, scroll_events: 0, path: 'straight', checkout_ms: rng.int(400, 1_500) }
}

interface OrderOpts {
  id?: string
  customer: Customer
  placedAt: Date
  kind: 'human' | 'muse' | 'dots' | 'signed' | 'declared'
  lines?: OrderLine[]
  lineCount?: number
  device?: Device
  address?: Address
  nameMismatch?: boolean
  delivered?: boolean
  deliveryAddressMatch?: boolean
  scenario?: string[]
}

function makeOrder(o: OrderOpts): Order {
  const id = o.id ?? `ord_${orderSeq++}`
  const lines = pickLines(o.lineCount ?? rng.int(1, 3), o.lines)
  const subtotal = round2(lines.reduce((s, l) => s + l.unit_price * l.qty, 0))
  const shipping = subtotal >= 150 ? 0 : 9
  const addr = o.address ?? addresses.find((a) => a.id === o.customer.address_ids[0])!
  const isAgent = o.kind !== 'human'
  const device = o.device ?? (o.kind === 'muse' || o.kind === 'dots' ? makeDevice('muse') : isAgent ? makeDevice('agent') : devices.find((d) => d.id === o.customer.device_ids[0])!)
  const sessKind = o.kind === 'human' ? 'human' : o.kind === 'signed' ? 'signed' : o.kind === 'declared' ? 'declared' : 'muse'
  const agentOrigin = o.kind === 'signed' ? rng.pick(SIGNED_AGENTS).origin : undefined
  const sess = session(sessKind, device, agentOrigin)

  let payment: PaymentInstrument
  let agent_identity: AgentIdentity | undefined
  if (o.kind === 'muse' || o.kind === 'dots') {
    payment = { id: `pm_${rng.hex(8)}`, kind: 'link_single_use', brand: 'visa', last4: String(rng.int(1000, 9999)), bin: '400000', name_on_card: o.nameMismatch ? `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}` : o.customer.name }
  } else if (o.kind === 'signed') {
    const useSpt = rng.chance(0.6)
    payment = useSpt
      ? { id: `pm_${rng.hex(8)}`, kind: 'spt', brand: 'visa', last4: String(rng.int(1000, 9999)), bin: '424242', name_on_card: o.customer.name }
      : { ...cardFor(o.customer), id: `pm_${rng.hex(8)}` }
    const created = Math.floor(o.placedAt.getTime() / 1000)
    agent_identity = {
      declared_user_agent: sess.user_agent,
      web_bot_auth: { signature_agent: agentOrigin!, keyid: rng.hex(43), tag: 'agent-payer-auth', created, expires: created + 300, nonce: rng.hex(32), alg: 'ed25519', verified: true },
      visa_tap: { sub: `acr_${rng.hex(16)}`, amr: ['passkey', 'hwk'], auth_time: created - rng.int(20, 240), kid: `visa-tap-${rng.hex(6)}`, iss: 'https://mcp.visa.com' },
      spt: useSpt ? { token: `spt_${rng.hex(20)}`, seller: MERCHANT.stripe_account, usage_limits: { amount: Math.round((subtotal + shipping) * 100), currency: 'usd', expires_at: iso(addDays(o.placedAt, 1)) }, deactivated_reason: 'used' } : undefined,
      ap2_mandate_hash: rng.chance(0.5) ? `sha256:${rng.hex(64)}` : undefined,
      ucp_agent_profile: `${agentOrigin}/.well-known/ucp`,
    }
  } else if (o.kind === 'declared') {
    payment = { ...cardFor(o.customer), id: `pm_${rng.hex(8)}` }
    agent_identity = { declared_user_agent: sess.user_agent }
  } else {
    payment = cardFor(o.customer)
  }

  const shippedAt = addDays(o.placedAt, rng.int(1, 2))
  const delivered = o.delivered ?? true
  const order: Order = {
    id,
    charge_id: `ch_test_${rng.hex(14)}`,
    customer_id: o.customer.id,
    placed_at: iso(o.placedAt),
    channel: o.kind === 'human' ? 'web' : o.kind === 'muse' ? 'muse' : o.kind === 'dots' ? 'dots' : o.kind === 'declared' ? 'declared-agent' : 'signed-agent',
    lines,
    subtotal,
    shipping,
    total: round2(subtotal + shipping),
    currency: 'usd',
    shipping_address_id: addr.id,
    billing_address_id: addr.id,
    payment,
    session: sess,
    agent_identity,
    fulfillment: {
      carrier: rng.pick(['UPS', 'USPS', 'FedEx'] as const),
      tracking: `1Z${rng.hex(16).toUpperCase()}`,
      shipped_at: iso(shippedAt),
      delivered_at: delivered ? iso(addDays(shippedAt, rng.int(2, 5))) : null,
      proof_of_delivery: delivered ? rng.pick(['scan', 'scan', 'photo', 'signature'] as const) : null,
      delivery_address_match: o.deliveryAddressMatch ?? true,
    },
    confirmation_email: { sent_at: iso(addMin(o.placedAt, 1)), to: o.customer.email, subject: `Order ${id.replace('ord_', '#')} confirmed` },
    policy_snapshot: { version: MERCHANT.return_policy.version, return_window_days: MERCHANT.return_policy.window_days, accepted_at: iso(o.placedAt), url: MERCHANT.return_policy.url },
    scenario: o.scenario,
  }
  orders.push(order)
  return order
}

function photo(kind: 'genuine' | 'synthetic' | 'reused', takenAt?: Date): ClaimPhoto {
  if (kind === 'genuine') return { id: `ph_${rng.hex(6)}`, filename: `IMG_${rng.int(1000, 9999)}.HEIC`, exif_present: true, camera_model: rng.pick(['iPhone 16 Pro', 'Pixel 9', 'Galaxy S25']), generator_watermark: false, duplicated_region_score: round2(rng.next() * 0.12), taken_at: iso(takenAt ?? daysAgo(rng.int(1, 20))) }
  if (kind === 'synthetic') return { id: `ph_${rng.hex(6)}`, filename: `damage_${rng.int(1, 9)}.png`, exif_present: false, camera_model: null, generator_watermark: true, duplicated_region_score: round2(0.7 + rng.next() * 0.25), taken_at: null }
  return { id: `ph_${rng.hex(6)}`, filename: `return_${rng.int(1, 9)}.jpg`, exif_present: false, camera_model: null, generator_watermark: false, duplicated_region_score: round2(0.4 + rng.next() * 0.3), taken_at: null }
}

interface ReturnOpts {
  id?: string
  order: Order
  kind?: ReturnRequest['kind']
  reason: string
  claim_text: string
  lineIdx?: number[]
  via?: ReturnRequest['via']
  photos?: ClaimPhoto[]
  daysAfterDelivery?: number
  inbound?: 'match' | 'empty' | 'none' | 'light'
  refund?: ReturnRequest['refund'] | 'auto_on_scan' | 'after_inspection' | 'instant' | 'declined' | 'pending'
  scenario?: string[]
}

function makeReturn(o: ReturnOpts): ReturnRequest {
  const id = o.id ?? `ret_${returnSeq++}`
  const delivered = o.order.fulfillment.delivered_at ? new Date(o.order.fulfillment.delivered_at) : new Date(o.order.placed_at)
  const requestedAt = addDays(delivered, o.daysAfterDelivery ?? rng.int(1, 25))
  const idx = o.lineIdx ?? [0]
  const lines = idx.map((i) => {
    const l = o.order.lines[i]
    return { sku: l.sku, size: l.size, qty: l.qty, amount: round2(l.unit_price * l.qty) }
  })
  const amount = round2(lines.reduce((s, l) => s + l.amount, 0))
  const expected = idx.reduce((s, i) => s + o.order.lines[i].weight_g * o.order.lines[i].qty, 0)
  const kind = o.kind ?? 'return'
  let carrier_inbound: ReturnRequest['carrier_inbound'] = null
  let status: ReturnRequest['status'] = 'requested'
  let refund: ReturnRequest['refund'] = null
  const inbound = o.inbound ?? (kind === 'return' ? 'match' : 'none')
  if (kind === 'return' && inbound !== 'none') {
    const firstScan = addDays(requestedAt, rng.int(1, 4))
    const received = addDays(firstScan, rng.int(2, 5))
    const w = inbound === 'match' ? Math.round(expected * (0.95 + rng.next() * 0.1) + 40) : inbound === 'empty' ? rng.int(140, 220) : Math.round(expected * 0.45)
    carrier_inbound = { tracking: `RT${rng.hex(14).toUpperCase()}`, first_scan_at: iso(firstScan), received_at: iso(received), inbound_weight_g: w, expected_weight_g: expected }
    status = 'received'
  }
  if (o.refund === 'auto_on_scan' && carrier_inbound) {
    refund = { amount, issued_at: iso(addMin(new Date(carrier_inbound.first_scan_at!), rng.int(1, 9))), trigger: 'carrier_scan' }
    status = 'refunded'
  } else if (o.refund === 'after_inspection' && carrier_inbound) {
    refund = { amount, issued_at: iso(addDays(new Date(carrier_inbound.received_at!), rng.int(1, 3))), trigger: 'inspection' }
    status = 'refunded'
  } else if (o.refund === 'instant') {
    refund = { amount, issued_at: iso(addMin(requestedAt, rng.int(2, 30))), trigger: 'instant' }
    status = 'refunded'
  } else if (o.refund === 'declined') {
    status = 'declined'
  } else if (o.refund && typeof o.refund === 'object') {
    refund = o.refund
    status = 'refunded'
  }
  const r: ReturnRequest = {
    id,
    order_id: o.order.id,
    customer_id: o.order.customer_id,
    kind,
    requested_at: iso(requestedAt),
    reason: o.reason,
    claim_text: o.claim_text,
    lines,
    amount,
    photos: o.photos ?? [],
    via: o.via ?? 'portal',
    status,
    carrier_inbound,
    refund,
    scenario: o.scenario,
  }
  returns.push(r)
  return r
}

interface DisputeOpts {
  id?: string
  order: Order
  reason: Dispute['reason']
  statement: string
  status?: Dispute['status']
  createdDaysAgo?: number
  is_inquiry?: boolean
  scenario?: string[]
}

function makeDispute(o: DisputeOpts): Dispute {
  const id = o.id ?? `dp_test_${rng.hex(8)}_${disputeSeq++}`
  const network = o.order.payment.brand === 'mastercard' ? 'mastercard' : 'visa'
  const codes: Record<Dispute['reason'], [string, string]> = {
    fraudulent: ['10.4', '4837'],
    product_not_received: ['13.1', '4855'],
    product_unacceptable: ['13.3', '4853'],
    credit_not_processed: ['13.6', '4860'],
    duplicate: ['12.6', '4834'],
    unrecognized: ['10.4', '4837'],
  }
  const created = daysAgo(o.createdDaysAgo ?? rng.int(3, 40))
  const d: Dispute = {
    id,
    charge_id: o.order.charge_id,
    order_id: o.order.id,
    network,
    reason: o.reason,
    reason_code: codes[o.reason][network === 'visa' ? 0 : 1],
    amount: o.order.total,
    is_inquiry: o.is_inquiry ?? false,
    status: o.status ?? 'needs_response',
    created_at: iso(created),
    evidence_due_by: iso(addDays(created, 7)),
    cardholder_statement: o.statement,
    scenario: o.scenario,
  }
  disputes.push(d)
  return d
}

// ---------------------------------------------------------------------------
// Population 1: ordinary human customers
// ---------------------------------------------------------------------------
const humans: Customer[] = []
for (let i = 0; i < 48; i++) humans.push(makeCustomer({ createdDaysAgo: rng.int(40, 700) }))
for (const c of humans) {
  const n = rng.int(1, 5)
  for (let k = 0; k < n; k++) {
    const created = new Date(c.account_created_at)
    const maxAgo = Math.min(270, Math.floor((NOW.getTime() - created.getTime()) / DAY) - 1)
    makeOrder({ customer: c, placedAt: daysAgo(rng.int(3, Math.max(4, maxAgo))), kind: 'human' })
  }
}
// Some ordinary returns, all legitimate shapes
for (const o of rng.shuffle(orders).slice(0, 18)) {
  if (!o.fulfillment.delivered_at) continue
  const reason = rng.pick(['wrong_size', 'changed_mind', 'defective', 'wrong_size'])
  makeReturn({ order: o, reason, claim_text: reason === 'defective' ? 'Zipper failed on the second wear.' : reason === 'wrong_size' ? 'Runs small, need the next size up.' : 'Decided against it, unworn with tags.', photos: reason === 'defective' ? [photo('genuine', addDays(new Date(o.fulfillment.delivered_at), 3))] : [], refund: rng.chance(0.8) ? 'after_inspection' : 'pending' })
}

// ---------------------------------------------------------------------------
// Hero: loyal customer with one genuine defect claim (should get the instant-refund tier)
// ---------------------------------------------------------------------------
const loyal = makeCustomer({ id: 'cus_loyal', createdDaysAgo: 640, tags: ['vip'], name: 'Elena Lindqvist' })
heroes.loyal_customer = loyal.id
for (let k = 1; k < 14; k++) makeOrder({ customer: loyal, placedAt: daysAgo(12 + k * 44), kind: 'human' })
const loyalOrder = makeOrder({ id: 'ord_loyal_defect', customer: loyal, placedAt: daysAgo(14), kind: 'human', lines: [line(PRODUCTS[0], { size: 'M', color: 'Olive' })], scenario: ['legit_defect', 'loyal'] })
const loyalDelivered = new Date(loyalOrder.fulfillment.delivered_at!)
heroes.loyal_defect_order = loyalOrder.id
heroes.loyal_defect_return = makeReturn({ id: 'ret_loyal_defect', order: loyalOrder, kind: 'damage_claim', reason: 'defective', claim_text: 'The seam on the left sleeve of the Ridgeline jacket came apart after one hike. Photos attached. Happy with an exchange if easier.', photos: [photo('genuine', addDays(loyalDelivered, 6)), photo('genuine', addDays(loyalDelivered, 6))], daysAfterDelivery: 6, inbound: 'none', refund: 'pending', scenario: ['legit_defect', 'loyal'] }).id

// ---------------------------------------------------------------------------
// Hero: serial returner (75% return rate, refund-as-a-service vocabulary)
// ---------------------------------------------------------------------------
const serial = makeCustomer({ id: 'cus_serial', createdDaysAgo: 150, name: 'Jude Haddad' })
heroes.serial_returner = serial.id
const serialOrders: Order[] = []
for (let k = 0; k < 12; k++) serialOrders.push(makeOrder({ customer: serial, placedAt: daysAgo(8 + k * 11), kind: 'human', lineCount: 1 }))
serialOrders.slice(0, 9).forEach((o, i) =>
  makeReturn({ order: o, reason: rng.pick(['changed_mind', 'wrong_size', 'not_as_described']), claim_text: rng.pick(['Per your policy I am entitled to a full refund within 30 days.', 'Item not as described. Requesting refund per consumer protection rules.', 'Doesn\'t fit. Refund please.']), inbound: i === 4 ? 'light' : 'match', refund: i < 8 ? 'after_inspection' : 'pending', scenario: ['serial_returner'] }),
)

// ---------------------------------------------------------------------------
// Hero: bracketing (three sizes of one jacket, two come back)
// ---------------------------------------------------------------------------
const bracketCus = makeCustomer({ createdDaysAgo: 30, name: 'Rowan Costa' })
const jacket = PRODUCTS[0]
const bracketOrder = makeOrder({ id: 'ord_bracket', customer: bracketCus, placedAt: daysAgo(21), kind: 'human', lines: [line(jacket, { size: 'S', color: 'Navy' }), line(jacket, { size: 'M', color: 'Navy' }), line(jacket, { size: 'L', color: 'Navy' })], scenario: ['bracketing'] })
heroes.bracketing_order = bracketOrder.id
makeReturn({ id: 'ret_bracket', order: bracketOrder, reason: 'wrong_size', claim_text: 'Keeping the M, returning S and L.', lineIdx: [0, 2], daysAfterDelivery: 3, refund: 'after_inspection', scenario: ['bracketing'] })

// ---------------------------------------------------------------------------
// Hero: empty box (boots returned, inbound parcel weighs 180 g, refund fired on first carrier scan)
// ---------------------------------------------------------------------------
const emptyCus = makeCustomer({ createdDaysAgo: 19, name: 'Kai Novak' })
const boots = PRODUCTS[2]
const emptyOrder = makeOrder({ id: 'ord_emptybox', customer: emptyCus, placedAt: daysAgo(17), kind: 'human', lines: [line(boots, { size: '10' })], scenario: ['empty_box'] })
heroes.empty_box_order = emptyOrder.id
makeReturn({ id: 'ret_emptybox', order: emptyOrder, reason: 'wrong_size', claim_text: 'Too narrow. Sending back.', daysAfterDelivery: 2, inbound: 'empty', refund: 'auto_on_scan', scenario: ['empty_box', 'scan_to_refund'] })

// ---------------------------------------------------------------------------
// Hero: AI-generated damage photos on a brand-new account
// ---------------------------------------------------------------------------
const aiCus = makeCustomer({ createdDaysAgo: 9, name: 'Silas Bauer' })
const parka = PRODUCTS[1]
const aiOrder = makeOrder({ id: 'ord_aiphoto', customer: aiCus, placedAt: daysAgo(8), kind: 'human', lines: [line(parka, { size: 'L', color: 'Black' })], scenario: ['ai_photo'] })
heroes.ai_photo_order = aiOrder.id
makeReturn({ id: 'ret_aiphoto', order: aiOrder, kind: 'damage_claim', reason: 'arrived_damaged', claim_text: 'Parka arrived with a large tear across the chest baffle and down leaking everywhere. Under your 30-day policy and the Consumer Rights Act I request an immediate full refund without return shipping, as the item is unfit for purpose.', photos: [photo('synthetic'), photo('synthetic'), photo('reused')], daysAfterDelivery: 1, inbound: 'none', refund: 'pending', via: 'email', scenario: ['ai_photo', 'policy_lawyer'] })

// ---------------------------------------------------------------------------
// Hero: multi-account ring (5 accounts, 2 shared devices, 1 shared address, INR claims)
// ---------------------------------------------------------------------------
const ringAddr = makeAddress('J. Mercer', 'addr_ring')
const ringDevA = makeDevice('human', 'dev_ring_a')
const ringDevB = makeDevice('human', 'dev_ring_b')
const ringNames = ['Jordan Mercer', 'J. Mercer', 'Jordan M.', 'Dana Mercer', 'Jo Mercer']
const ringOrders: Order[] = []
ringNames.forEach((name, i) => {
  const c = makeCustomer({ id: `cus_ring_${i + 1}`, createdDaysAgo: rng.int(6, 40), name, address: ringAddr, devices: i % 2 === 0 ? [ringDevA] : [ringDevB, ringDevA], tags: [] })
  const o = makeOrder({ customer: c, placedAt: daysAgo(rng.int(5, 30)), kind: 'human', lineCount: rng.int(1, 2), scenario: ['ring'] })
  ringOrders.push(o)
  makeReturn({ order: o, kind: 'inr_claim', reason: 'item_not_received', claim_text: rng.pick(['Tracking says delivered but nothing arrived. Please refund or reship.', 'Package never showed up. Neighbors have not seen it either.', 'Marked delivered, not received. Refund requested.']), daysAfterDelivery: 1, inbound: 'none', refund: i < 2 ? 'instant' : 'pending', scenario: ['ring', 'inr'] })
})
heroes.ring_address = ringAddr.id
heroes.ring_orders = ringOrders.map((o) => o.id).join(',')

// ---------------------------------------------------------------------------
// Population 2: undeclared agents (Muse-like and Dots-like sessions), since Sept 8 / Sept 29
// ---------------------------------------------------------------------------
const museUsers: Customer[] = []
for (let i = 0; i < 9; i++) museUsers.push(makeCustomer({ createdDaysAgo: rng.int(2, 300) }))
for (let i = 0; i < 30; i++) {
  const c = rng.pick(museUsers)
  const createdAgo = Math.floor((NOW.getTime() - new Date(c.account_created_at).getTime()) / DAY)
  makeOrder({ customer: c, placedAt: daysAgo(rng.int(1, Math.min(24, Math.max(1, createdAgo - 1)))), kind: 'muse', nameMismatch: rng.chance(0.2), lineCount: rng.int(1, 2) })
}
for (let i = 0; i < 5; i++) makeOrder({ customer: rng.pick(museUsers), placedAt: daysAgo(rng.int(1, 3)), kind: 'dots', lineCount: 1 })

// Muse picked the wrong colour (Navy vs Midnight), honest return via the agent
const wrongColorCus = rng.pick(museUsers)
const wrongColor = makeOrder({ id: 'ord_muse_wrongcolor', customer: wrongColorCus, placedAt: daysAgo(12), kind: 'muse', lines: [line(jacket, { size: 'M', color: 'Midnight' })], scenario: ['agent_misread'] })
heroes.agent_misread_order = wrongColor.id
makeReturn({ id: 'ret_muse_wrongcolor', order: wrongColor, reason: 'not_as_described', claim_text: 'I asked for the navy jacket and received a black one. Please exchange for Navy, size M.', via: 'agent', daysAfterDelivery: 2, refund: 'pending', scenario: ['agent_misread'] })

// Hero: double-dip. Muse order, refund fired on carrier scan, then a "my agent did it" chargeback on the same charge.
const ddCus = makeCustomer({ id: 'cus_doubledip', createdDaysAgo: 16, name: 'Theo Walsh' })
const ddOrder = makeOrder({ id: 'ord_doubledip', customer: ddCus, placedAt: daysAgo(15), kind: 'muse', lines: [line(parka, { size: 'M', color: 'Spruce' })], nameMismatch: false, scenario: ['double_dip', 'undeclared_agent'] })
heroes.double_dip_order = ddOrder.id
makeReturn({ id: 'ret_doubledip', order: ddOrder, reason: 'changed_mind', claim_text: 'Returning the parka, unworn.', via: 'agent', daysAfterDelivery: 2, inbound: 'match', refund: 'auto_on_scan', scenario: ['double_dip'] })
heroes.double_dip_dispute = makeDispute({ id: 'dp_doubledip', order: ddOrder, reason: 'fraudulent', statement: 'I did not make this purchase. An AI assistant on my phone placed it without my approval.', status: 'needs_response', createdDaysAgo: 2, scenario: ['double_dip', 'agent_did_it'] }).id

// ---------------------------------------------------------------------------
// Population 3: signed agents (Web Bot Auth + Visa TAP), since mid-August
// ---------------------------------------------------------------------------
const signedUsers: Customer[] = []
for (let i = 0; i < 7; i++) signedUsers.push(makeCustomer({ createdDaysAgo: rng.int(60, 500) }))
for (let i = 0; i < 20; i++) makeOrder({ customer: rng.pick(signedUsers), placedAt: daysAgo(rng.int(1, 48)), kind: 'signed', lineCount: rng.int(1, 2) })
// Hero: a signed-agent order disputed as fraud; the vault holds passkey-authenticated TAP claims and a mandate.
const signedCus = rng.pick(signedUsers)
const signedOrder = makeOrder({ id: 'ord_signed_disputed', customer: signedCus, placedAt: daysAgo(20), kind: 'signed', lines: [line(PRODUCTS[7], { size: '10' })], scenario: ['signed_disputed'] })
signedOrder.agent_identity!.ap2_mandate_hash = `sha256:${rng.hex(64)}`
heroes.signed_disputed_order = signedOrder.id
heroes.signed_dispute = makeDispute({ id: 'dp_signed', order: signedOrder, reason: 'fraudulent', statement: 'I do not recognise this charge.', status: 'needs_response', createdDaysAgo: 3, scenario: ['signed_disputed'] }).id

// Population 4: declared-but-unsigned agents (UA token only)
for (let i = 0; i < 4; i++) makeOrder({ customer: rng.pick(signedUsers), placedAt: daysAgo(rng.int(1, 10)), kind: 'declared', lineCount: 1 })

// ---------------------------------------------------------------------------
// Background disputes with varied shapes
// ---------------------------------------------------------------------------
const humanDelivered = orders.filter((o) => o.channel === 'web' && o.fulfillment.delivered_at && !o.scenario)
for (const o of rng.shuffle(humanDelivered).slice(0, 5)) {
  const reason = rng.pick(['fraudulent', 'product_not_received', 'product_unacceptable'] as const)
  makeDispute({ order: o, reason, statement: reason === 'fraudulent' ? 'Card was used without my permission.' : reason === 'product_not_received' ? 'Never received the package.' : 'Item arrived damaged and seller ignored me.', status: rng.pick(['needs_response', 'under_review', 'won', 'lost'] as const), is_inquiry: rng.chance(0.3) })
}
const museDelivered = orders.filter((o) => o.channel === 'muse' && !o.scenario)
for (const o of rng.shuffle(museDelivered).slice(0, 3)) {
  makeDispute({ order: o, reason: rng.pick(['unrecognized', 'fraudulent'] as const), statement: rng.pick(['I don\'t recognise this merchant.', 'My shopping assistant bought this, I never approved it.']), status: rng.pick(['warning_needs_response', 'needs_response'] as const), is_inquiry: rng.chance(0.5) })
}

// ---------------------------------------------------------------------------
orders.sort((a, b) => a.placed_at.localeCompare(b.placed_at))
returns.sort((a, b) => a.requested_at.localeCompare(b.requested_at))
disputes.sort((a, b) => a.created_at.localeCompare(b.created_at))

const dataset: Dataset = { generated_at: iso(NOW), merchant: MERCHANT, products: PRODUCTS, addresses, devices, customers, orders, returns, disputes, heroes }
const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../data/dataset.json')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(dataset, null, 1))

const byChannel = orders.reduce<Record<string, number>>((m, o) => ((m[o.channel] = (m[o.channel] ?? 0) + 1), m), {})
console.log(`wrote ${out}`)
console.log({ customers: customers.length, orders: orders.length, byChannel, returns: returns.length, disputes: disputes.length, devices: devices.length })
console.log('heroes', heroes)
