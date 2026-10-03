import type { AgentIdentity, AgentPopulation, Customer, Dataset, Device, Dispute, Order, ReturnRequest } from './types.js'

export interface PopulationSignal {
  signal: string
  detail: string
  weight: number
}

/** Shape of Stripe `evidence.enhanced_evidence.visa_compelling_evidence_3.*` transactions. */
export interface Ce3Transaction {
  charge: string
  customer_account_id: string
  customer_device_fingerprint: string
  customer_device_id: string
  customer_email_address: string
  customer_purchase_ip: string
  product_description: string
  shipping_address: { line1: string; city: string; state: string; postal_code: string; country: string }
  /** Not a Stripe field: days before the reference date, kept for the 120 to 365 day rule. */
  age_days: number
  matched_fields: string[]
}

export interface CustomerHistory {
  account_age_days: number
  orders: number
  first_order: boolean
  returns: number
  inr_claims: number
  damage_claims: number
  return_rate: number
  refund_dollars: number
  order_dollars: number
  refund_ratio: number
}

export interface Linkage {
  shared_device_customers: string[]
  shared_address_customers: string[]
  shared_payment_customers: string[]
}

export interface ReturnSummary {
  id: string
  kind: ReturnRequest['kind']
  reason: string
  status: ReturnRequest['status']
  amount: number
  requested_at: string
  via: ReturnRequest['via']
  refund: ReturnRequest['refund']
  scan_to_refund_minutes: number | null
  inbound_weight_ratio: number | null
  photo_findings: string[]
  claim_findings: string[]
}

export interface DisputeSummary {
  id: string
  network: Dispute['network']
  reason: Dispute['reason']
  reason_code: string
  status: Dispute['status']
  amount: number
  created_at: string
  evidence_due_by: string
  is_inquiry: boolean
  cardholder_statement: string
}

export interface EvidenceVault {
  order_id: string
  charge_id: string
  customer_id: string
  customer_name: string
  placed_at: string
  total: number
  lines: Order['lines']
  population: AgentPopulation
  population_score: number
  population_signals: PopulationSignal[]
  visa_compelling_evidence_3: {
    disputed_transaction: Omit<Ce3Transaction, 'charge' | 'age_days' | 'matched_fields'> & { merchandise_or_services: 'merchandise' }
    prior_undisputed_transactions: Ce3Transaction[]
  } | null
  ce3: { eligible: boolean; qualifying_transactions: number; reason: string }
  agent_identity: AgentIdentity | null
  delivery: Order['fulfillment']
  policy_snapshot: Order['policy_snapshot']
  confirmation_email: Order['confirmation_email']
  payment: { kind: Order['payment']['kind']; brand: string; last4: string; name_on_card: string; name_matches_account: boolean }
  session: Order['session']
  customer_history: CustomerHistory
  linkage: Linkage
  returns: ReturnSummary[]
  disputes: DisputeSummary[]
  flags: string[]
}

const DAY = 86_400_000
const CLOUD_ASNS = new Set([13335, 54113])
const POLICY_LAWYER = /\b(policy|entitled|consumer (rights|protection)|act\b|unfit for purpose|immediate(ly)? (full )?refund)/i

export class VaultBuilder {
  private orders = new Map<string, Order>()
  private customers = new Map<string, Customer>()
  private devices = new Map<string, Device>()
  private ordersByCustomer = new Map<string, Order[]>()
  private returnsByOrder = new Map<string, ReturnRequest[]>()
  private returnsByCustomer = new Map<string, ReturnRequest[]>()
  private disputesByCharge = new Map<string, Dispute[]>()
  private customersByDevice = new Map<string, Set<string>>()
  private customersByAddress = new Map<string, Set<string>>()
  private customersByPayment = new Map<string, Set<string>>()
  private fingerprintCount = new Map<string, number>()
  readonly now: Date

  constructor(public readonly data: Dataset, now = new Date(data.generated_at)) {
    this.now = now
    for (const o of data.orders) this.orders.set(o.id, o)
    for (const c of data.customers) this.customers.set(c.id, c)
    for (const d of data.devices) this.devices.set(d.id, d)
    const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => m.set(k, [...(m.get(k) ?? []), v])
    const add = (m: Map<string, Set<string>>, k: string, v: string) => m.set(k, (m.get(k) ?? new Set()).add(v))
    for (const o of data.orders) {
      push(this.ordersByCustomer, o.customer_id, o)
      add(this.customersByDevice, o.session.device_id, o.customer_id)
      add(this.customersByAddress, o.shipping_address_id, o.customer_id)
      if (o.payment.kind === 'card') add(this.customersByPayment, `${o.payment.bin}:${o.payment.last4}`, o.customer_id)
      const fp = this.devices.get(o.session.device_id)?.fingerprint
      if (fp) this.fingerprintCount.set(fp, (this.fingerprintCount.get(fp) ?? 0) + 1)
    }
    for (const c of data.customers) for (const d of c.device_ids) add(this.customersByDevice, d, c.id)
    for (const r of data.returns) {
      push(this.returnsByOrder, r.order_id, r)
      push(this.returnsByCustomer, r.customer_id, r)
    }
    for (const d of data.disputes) push(this.disputesByCharge, d.charge_id, d)
  }

  order(id: string): Order | undefined {
    return this.orders.get(id)
  }

  customer(id: string): Customer | undefined {
    return this.customers.get(id)
  }

  returnsFor(orderId: string): ReturnRequest[] {
    return this.returnsByOrder.get(orderId) ?? []
  }

  disputesFor(chargeId: string): Dispute[] {
    return this.disputesByCharge.get(chargeId) ?? []
  }

  ordersFor(customerId: string): Order[] {
    return this.ordersByCustomer.get(customerId) ?? []
  }

  /** Classify who placed the order. Uses only what the merchant observed at checkout, never the seed's channel label. */
  classify(o: Order): { population: AgentPopulation; score: number; signals: PopulationSignal[] } {
    const signals: PopulationSignal[] = []
    const ai = o.agent_identity
    if (ai?.web_bot_auth?.verified) {
      signals.push({ signal: 'web_bot_auth_verified', detail: `Ed25519 signature verified against ${ai.web_bot_auth.signature_agent} (keyid ${ai.web_bot_auth.keyid.slice(0, 8)}…, tag=${ai.web_bot_auth.tag})`, weight: 1 })
      if (ai.visa_tap) signals.push({ signal: 'visa_tap_token', detail: `Agentic Consumer Recognition token, amr=[${ai.visa_tap.amr.join(', ')}], auth ${Math.round((o.session.checkout_ms / 1000 + (Math.floor(new Date(o.placed_at).getTime() / 1000) - ai.visa_tap.auth_time)))}s before checkout`, weight: 0 })
      if (ai.spt) signals.push({ signal: 'shared_payment_token', detail: `SPT scoped to ${ai.spt.seller}, limit ${(ai.spt.usage_limits.amount / 100).toFixed(2)} ${ai.spt.usage_limits.currency.toUpperCase()}, ${ai.spt.deactivated_reason ?? 'active'}`, weight: 0 })
      if (ai.ap2_mandate_hash) signals.push({ signal: 'ap2_mandate', detail: `Signed cart mandate ${ai.ap2_mandate_hash.slice(0, 18)}…`, weight: 0 })
      return { population: 'signed', score: 1, signals }
    }
    if (ai?.declared_user_agent?.startsWith('Agent/')) {
      signals.push({ signal: 'declared_user_agent', detail: `UA declares ${ai.declared_user_agent.split(' ')[0]} but no request signature`, weight: 0.8 })
      return { population: 'declared', score: 0.8, signals }
    }
    const device = this.devices.get(o.session.device_id)
    const s = o.session
    let score = 0
    const hit = (signal: string, detail: string, weight: number) => {
      signals.push({ signal, detail, weight })
      score += weight
    }
    if (device?.cluster?.endsWith('-sandbox')) hit('sandbox_fingerprint_cluster', `Fingerprint ${device.fingerprint} is shared by ${this.fingerprintCount.get(device.fingerprint) ?? 1} sessions across different customers (${device.cluster.replace('-sandbox', '')} agent sandbox: ${device.hardware})`, 0.45)
    if (CLOUD_ASNS.has(s.asn)) hit('cloud_egress', `Purchase IP ${s.ip} egresses from ${s.asn_org} (AS${s.asn}), not a residential network`, 0.2)
    if (s.hover_events === 0 && s.scroll_events === 0) hit('no_pointer_telemetry', 'Zero hover and zero scroll events for the whole session', 0.15)
    if (s.path === 'straight') hit('straight_line_navigation', `${s.pages} pages, landed directly on product then checkout`, 0.05)
    if (s.duration_s < 90) hit('short_session', `Session lasted ${s.duration_s}s`, 0.1)
    if (s.checkout_ms < 10_000) hit('fast_checkout', `Checkout form completed in ${(s.checkout_ms / 1000).toFixed(1)}s`, 0.05)
    if (o.payment.kind === 'link_single_use') hit('single_use_card', `Fresh Link single-use card (${o.payment.brand} •••• ${o.payment.last4}) bound to this order`, 0.1)
    const cust = this.customers.get(o.customer_id)
    if (cust && o.payment.name_on_card !== cust.name) hit('name_mismatch', `Name on card "${o.payment.name_on_card}" differs from account "${cust.name}"`, 0.05)
    score = Math.min(1, Math.round(score * 100) / 100)
    return { population: score >= 0.5 ? 'undeclared-suspected' : 'human', score, signals }
  }

  private ce3Transaction(o: Order, ref: Order, refDate: Date): Ce3Transaction {
    const cust = this.customers.get(o.customer_id)!
    const addr = this.data.addresses.find((a) => a.id === o.shipping_address_id)!
    const dev = this.devices.get(o.session.device_id)
    const refDev = this.devices.get(ref.session.device_id)
    const matched: string[] = []
    if (o.session.ip === ref.session.ip) matched.push('customer_purchase_ip')
    if (dev && refDev && dev.id === refDev.id && !dev.cluster) matched.push('customer_device_id')
    if (dev && refDev && dev.fingerprint === refDev.fingerprint && !dev.cluster) matched.push('customer_device_fingerprint')
    if (o.customer_id === ref.customer_id) matched.push('customer_account_id')
    const refCust = this.customers.get(ref.customer_id)
    if (refCust && cust.email && cust.email === refCust.email) matched.push('customer_email_address')
    if (o.shipping_address_id === ref.shipping_address_id) matched.push('shipping_address')
    return {
      charge: o.charge_id,
      customer_account_id: o.customer_id,
      customer_device_fingerprint: dev?.fingerprint ?? '',
      customer_device_id: dev?.id ?? '',
      customer_email_address: cust.email,
      customer_purchase_ip: o.session.ip,
      product_description: o.lines.map((l) => `${l.name}${l.size ? ' ' + l.size : ''}${l.color ? ' ' + l.color : ''} x${l.qty}`).join('; '),
      shipping_address: { line1: addr.line1, city: addr.city, state: addr.state, postal_code: addr.postal_code, country: addr.country },
      age_days: Math.floor((refDate.getTime() - new Date(o.placed_at).getTime()) / DAY),
      matched_fields: matched,
    }
  }

  history(customerId: string, before: Date): CustomerHistory {
    const cust = this.customers.get(customerId)!
    const orders = this.ordersFor(customerId).filter((o) => new Date(o.placed_at) <= before)
    const rets = this.returnsByCustomer.get(customerId) ?? []
    const refundDollars = rets.reduce((s, r) => s + (r.refund?.amount ?? 0), 0)
    const orderDollars = orders.reduce((s, o) => s + o.total, 0)
    const returnsOnly = rets.filter((r) => r.kind === 'return')
    return {
      account_age_days: Math.floor((this.now.getTime() - new Date(cust.account_created_at).getTime()) / DAY),
      orders: orders.length,
      first_order: orders.length <= 1,
      returns: returnsOnly.length,
      inr_claims: rets.filter((r) => r.kind === 'inr_claim').length,
      damage_claims: rets.filter((r) => r.kind === 'damage_claim').length,
      return_rate: orders.length ? Math.round((rets.length / orders.length) * 100) / 100 : 0,
      refund_dollars: Math.round(refundDollars * 100) / 100,
      order_dollars: Math.round(orderDollars * 100) / 100,
      refund_ratio: orderDollars ? Math.round((refundDollars / orderDollars) * 100) / 100 : 0,
    }
  }

  linkage(o: Order): Linkage {
    const others = (m: Map<string, Set<string>>, k: string) => [...(m.get(k) ?? [])].filter((c) => c !== o.customer_id)
    const dev = this.devices.get(o.session.device_id)
    return {
      shared_device_customers: dev?.cluster ? [] : others(this.customersByDevice, o.session.device_id),
      shared_address_customers: others(this.customersByAddress, o.shipping_address_id),
      shared_payment_customers: o.payment.kind === 'card' ? others(this.customersByPayment, `${o.payment.bin}:${o.payment.last4}`) : [],
    }
  }

  summarizeReturn(r: ReturnRequest): ReturnSummary {
    const photoFindings: string[] = []
    for (const p of r.photos) {
      if (p.generator_watermark) photoFindings.push(`${p.filename}: generator watermark detected`)
      if (!p.exif_present) photoFindings.push(`${p.filename}: no EXIF metadata`)
      if (p.duplicated_region_score >= 0.6) photoFindings.push(`${p.filename}: duplicated-region score ${p.duplicated_region_score}`)
    }
    const claimFindings: string[] = []
    if (POLICY_LAWYER.test(r.claim_text)) claimFindings.push('policy-citation density high (policy-lawyer pattern)')
    if (r.via === 'agent') claimFindings.push('submitted by a shopper agent, not the account holder directly')
    let scanToRefund: number | null = null
    if (r.refund && r.carrier_inbound?.first_scan_at && r.refund.trigger === 'carrier_scan') scanToRefund = Math.round((new Date(r.refund.issued_at).getTime() - new Date(r.carrier_inbound.first_scan_at).getTime()) / 60_000)
    const ratio = r.carrier_inbound?.inbound_weight_g != null ? Math.round((r.carrier_inbound.inbound_weight_g / r.carrier_inbound.expected_weight_g) * 100) / 100 : null
    return { id: r.id, kind: r.kind, reason: r.reason, status: r.status, amount: r.amount, requested_at: r.requested_at, via: r.via, refund: r.refund, scan_to_refund_minutes: scanToRefund, inbound_weight_ratio: ratio, photo_findings: photoFindings, claim_findings: claimFindings }
  }

  summarizeDispute(d: Dispute): DisputeSummary {
    return { id: d.id, network: d.network, reason: d.reason, reason_code: d.reason_code, status: d.status, amount: d.amount, created_at: d.created_at, evidence_due_by: d.evidence_due_by, is_inquiry: d.is_inquiry, cardholder_statement: d.cardholder_statement }
  }

  build(orderId: string): EvidenceVault | undefined {
    const o = this.orders.get(orderId)
    if (!o) return undefined
    const cust = this.customers.get(o.customer_id)!
    const cls = this.classify(o)
    const disputes = this.disputesFor(o.charge_id)
    const refDate = disputes[0] ? new Date(disputes[0].created_at) : this.now
    const priors = this.ordersFor(o.customer_id)
      .filter((p) => p.id !== o.id && this.disputesFor(p.charge_id).length === 0)
      .map((p) => this.ce3Transaction(p, o, refDate))
      .filter((t) => t.age_days >= 120 && t.age_days <= 365)
      .filter((t) => t.matched_fields.length >= 2 && (t.matched_fields.includes('customer_purchase_ip') || t.matched_fields.includes('customer_device_id') || t.matched_fields.includes('customer_device_fingerprint')))
      .slice(0, 5)
    const dev = this.devices.get(o.session.device_id)
    const ce3Reason = cls.population === 'signed'
      ? 'Agent order: no human device or IP. Use TAP token, mandate and delivery proof instead.'
      : dev?.cluster?.endsWith('-sandbox')
        ? 'Device fingerprint is a shared agent sandbox image, not customer-identifying; CE 3.0 matching on device is invalid.'
        : dev?.cluster === 'agent-runtime'
          ? 'Agent runtime device, not customer-identifying; CE 3.0 device matching does not apply.'
          : priors.length >= 2
            ? `${priors.length} prior undisputed transactions 120 to 365 days old match on ${[...new Set(priors.flatMap((p) => p.matched_fields))].join(', ')}.`
            : `Only ${priors.length} qualifying prior transaction(s); CE 3.0 needs two.`
    const disputed = this.ce3Transaction(o, o, refDate)
    const returns = this.returnsFor(o.id).map((r) => this.summarizeReturn(r))
    const history = this.history(o.customer_id, this.now)
    const linkage = this.linkage(o)
    const flags = this.deriveFlags(o, cls.population, returns, disputes, history, linkage)
    return {
      order_id: o.id,
      charge_id: o.charge_id,
      customer_id: o.customer_id,
      customer_name: cust.name,
      placed_at: o.placed_at,
      total: o.total,
      lines: o.lines,
      population: cls.population,
      population_score: cls.score,
      population_signals: cls.signals,
      visa_compelling_evidence_3: cls.population === 'signed' ? null : {
        disputed_transaction: {
          customer_account_id: disputed.customer_account_id,
          customer_device_fingerprint: disputed.customer_device_fingerprint,
          customer_device_id: disputed.customer_device_id,
          customer_email_address: disputed.customer_email_address,
          customer_purchase_ip: disputed.customer_purchase_ip,
          product_description: disputed.product_description,
          shipping_address: disputed.shipping_address,
          merchandise_or_services: 'merchandise',
        },
        prior_undisputed_transactions: priors,
      },
      ce3: { eligible: priors.length >= 2 && !dev?.cluster, qualifying_transactions: priors.length, reason: ce3Reason },
      agent_identity: o.agent_identity ?? null,
      delivery: o.fulfillment,
      policy_snapshot: o.policy_snapshot,
      confirmation_email: o.confirmation_email,
      payment: { kind: o.payment.kind, brand: o.payment.brand, last4: o.payment.last4, name_on_card: o.payment.name_on_card, name_matches_account: o.payment.name_on_card === cust.name },
      session: o.session,
      customer_history: history,
      linkage,
      returns,
      disputes: disputes.map((d) => this.summarizeDispute(d)),
      flags,
    }
  }

  private deriveFlags(o: Order, population: AgentPopulation, returns: ReturnSummary[], disputes: Dispute[], h: CustomerHistory, l: Linkage): string[] {
    const flags = new Set<string>()
    if (population === 'undeclared-suspected') flags.add('undeclared_agent')
    if (population === 'declared') flags.add('declared_unsigned_agent')
    if (returns.some((r) => r.refund) && disputes.length) flags.add('double_dip')
    if (returns.some((r) => r.inbound_weight_ratio != null && r.inbound_weight_ratio < 0.35)) flags.add('empty_box')
    if (returns.some((r) => r.inbound_weight_ratio != null && r.inbound_weight_ratio >= 0.35 && r.inbound_weight_ratio < 0.7)) flags.add('partial_return_weight')
    if (returns.some((r) => r.scan_to_refund_minutes != null && r.scan_to_refund_minutes < 60)) flags.add('refund_on_first_scan')
    const bySku = new Map<string, Set<string>>()
    for (const li of o.lines) if (li.size) bySku.set(li.sku, (bySku.get(li.sku) ?? new Set()).add(li.size))
    if ([...bySku.values()].some((s) => s.size >= 3)) flags.add('bracketing')
    if (returns.some((r) => r.photo_findings.some((f) => f.includes('watermark') || f.includes('duplicated')))) flags.add('synthetic_photo')
    if (returns.some((r) => r.claim_findings.some((f) => f.includes('policy-lawyer')))) flags.add('policy_lawyer')
    if (returns.some((r) => r.kind === 'inr_claim')) flags.add('inr_claim')
    if (l.shared_device_customers.length + l.shared_address_customers.length >= 2) flags.add('ring_linkage')
    if (h.orders >= 5 && h.return_rate >= 0.5) flags.add('serial_returner')
    if (h.account_age_days < 14 && h.first_order) flags.add('new_account_first_order')
    if (o.payment.name_on_card !== this.customers.get(o.customer_id)?.name) flags.add('name_mismatch')
    if (!o.fulfillment.delivered_at || !o.fulfillment.proof_of_delivery) flags.add('no_delivery_proof')
    if (disputes.some((d) => /assistant|agent|ai\b/i.test(d.cardholder_statement))) flags.add('agent_did_it_claim')
    if (h.account_age_days > 365 && h.return_rate < 0.15) flags.add('established_low_risk')
    return [...flags]
  }
}
