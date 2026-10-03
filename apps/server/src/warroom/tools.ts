import type { CustomToolDeclaration } from '@zoowork-ai/sdk'
import type { AgentName, EvidenceFamily, EvidenceItem, Severity, VerdictTier, RoutingDecision } from '@receipts/seed'
import { data, vaultFor, vaults } from '../store.js'

const FAMILIES: EvidenceFamily[] = ['customer_history', 'order_shape', 'identity_linkage', 'logistics', 'claim_artifacts', 'velocity', 'double_dip', 'agent_identity', 'delivery']
const SEVERITIES: Severity[] = ['info', 'suspicious', 'critical', 'exculpatory']
export const TIERS: VerdictTier[] = ['instant_refund', 'exchange_first', 'refund_on_inspection', 'require_verification', 'decline']
export const DECISIONS: RoutingDecision[] = ['refund_and_close', 'representment', 'accept_loss']

const attachEvidence: CustomToolDeclaration = {
  name: 'attach_evidence',
  description: 'Attach one finding to the case file. Call once per distinct finding (1 to 4 per case). weight is -1..1 and takes the MERCHANT's side as positive: positive means the claim or dispute should be denied (abuse, double recovery, proven authorisation), negative means the customer's claim looks genuine and should be honoured. node_ids are ids of orders, customers, devices, addresses, returns or disputes the finding touches.',
  input_schema: {
    type: 'object',
    properties: {
      family: { type: 'string', enum: FAMILIES },
      label: { type: 'string', description: 'Short headline, under 60 characters' },
      detail: { type: 'string', description: 'One to three sentences with the concrete numbers' },
      severity: { type: 'string', enum: SEVERITIES, description: 'exculpatory = supports paying the customer; suspicious/critical = supports denying the claim or dispute; info = neutral' },
      weight: { type: 'number', minimum: -1, maximum: 1 },
      node_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['family', 'label', 'detail', 'severity', 'weight', 'node_ids'],
  },
}

const getOrderEvidence: CustomToolDeclaration = {
  name: 'get_order_evidence',
  description: 'Full evidence vault for an order: population classification and signals, CE 3.0 records, delivery, payment, session telemetry, customer history, linkage, returns, disputes, flags.',
  input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
}

const getCustomerHistory: CustomToolDeclaration = {
  name: 'get_customer_history',
  description: 'Account age, order count, returns, claims, return rate, refund ratio and every order with its flags for a customer.',
  input_schema: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] },
}

const traceReturn: CustomToolDeclaration = {
  name: 'trace_return',
  description: 'Carrier and refund timeline for a return: request, label, first inbound scan, received, inbound weight vs expected, refund trigger and timing.',
  input_schema: { type: 'object', properties: { return_id: { type: 'string' } }, required: ['return_id'] },
}

const classifySession: CustomToolDeclaration = {
  name: 'classify_session',
  description: 'Who placed the order: signed agent, declared agent, undeclared-suspected agent, or human, with the scored signals and any agent identity records (Web Bot Auth, Visa TAP, SPT, mandate).',
  input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
}

const findLinkedAccounts: CustomToolDeclaration = {
  name: 'find_linked_accounts',
  description: 'Other customer accounts sharing a device, shipping address or payment card with this order, with their claim history.',
  input_schema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] },
}

const inspectClaim: CustomToolDeclaration = {
  name: 'inspect_claim',
  description: 'The claim text, who submitted it, and photo forensics (EXIF, generator watermark, duplicated regions) for a return or claim; or the cardholder statement for a dispute.',
  input_schema: { type: 'object', properties: { return_id: { type: 'string' }, dispute_id: { type: 'string' } } },
}

const issueVerdict: CustomToolDeclaration = {
  name: 'issue_verdict',
  description: 'Issue the tiered verdict for the case. Exactly one call per case.',
  input_schema: {
    type: 'object',
    properties: {
      tier: { type: 'string', enum: TIERS },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      rationale: { type: 'string', description: 'Two to four sentences naming the decisive evidence' },
      policy_citation: { type: 'string' },
    },
    required: ['tier', 'confidence', 'rationale'],
  },
}

const routeDispute: CustomToolDeclaration = {
  name: 'route_dispute',
  description: 'For dispute cases only: choose how to respond. refund_and_close removes an inquiry from the VAMP count but pays the customer; representment fights it with the evidence vault; accept_loss does nothing.',
  input_schema: {
    type: 'object',
    properties: { decision: { type: 'string', enum: DECISIONS }, rationale: { type: 'string' } },
    required: ['decision', 'rationale'],
  },
}

export const TOOLS_BY_ROLE: Record<AgentName, CustomToolDeclaration[]> = {
  history: [getCustomerHistory, getOrderEvidence, attachEvidence],
  logistics: [traceReturn, getOrderEvidence, attachEvidence],
  identity: [classifySession, findLinkedAccounts, getOrderEvidence, attachEvidence],
  forensics: [inspectClaim, getOrderEvidence, attachEvidence],
  critic: [getOrderEvidence, issueVerdict, routeDispute],
}

/** Which evidence families each specialist may attach. Enforced in code so overlap stays low. */
export const FAMILIES_BY_ROLE: Record<AgentName, EvidenceFamily[]> = {
  history: ['customer_history', 'velocity'],
  logistics: ['logistics', 'delivery', 'double_dip'],
  identity: ['agent_identity', 'identity_linkage', 'order_shape'],
  forensics: ['claim_artifacts'],
  critic: FAMILIES,
}

/** Weight bands by severity, so a single fact cannot dominate the score. */
export function clampWeight(severity: Severity, weight: number): number {
  const w = Number.isFinite(weight) ? weight : 0
  switch (severity) {
    case 'info': return Math.max(-0.15, Math.min(0.15, w))
    case 'suspicious': return Math.max(0.1, Math.min(0.4, Math.abs(w)))
    case 'critical': return Math.max(0.4, Math.min(0.7, Math.abs(w)))
    case 'exculpatory': return -Math.max(0.1, Math.min(0.5, Math.abs(w)))
  }
}

export interface ToolContext {
  caseId: string
  orderId: string
  agent: AgentName
  attach: (agent: AgentName, item: Omit<EvidenceItem, 'id'>) => EvidenceItem
  verdict: (input: { tier: VerdictTier; confidence: number; rationale: string; policy_citation?: string }) => unknown
  route: (input: { decision: RoutingDecision; rationale: string }) => unknown
}

export async function executeTool(ctx: ToolContext, name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_order_evidence': {
      const v = vaultFor(String(input.order_id ?? ctx.orderId))
      if (!v) throw new Error(`unknown order ${input.order_id}`)
      const { visa_compelling_evidence_3, ...rest } = v
      return { ...rest, ce3_prior_transactions: visa_compelling_evidence_3?.prior_undisputed_transactions.length ?? 0 }
    }
    case 'get_customer_history': {
      const c = vaults.customer(String(input.customer_id))
      if (!c) throw new Error(`unknown customer ${input.customer_id}`)
      const orders = vaults.ordersFor(c.id).map((o) => vaultFor(o.id)!)
      return {
        customer: { id: c.id, name: c.name, email: c.email, account_created_at: c.account_created_at, tags: c.tags },
        history: vaults.history(c.id, vaults.now),
        orders: orders.map((v) => ({ order_id: v.order_id, placed_at: v.placed_at, total: v.total, population: v.population, flags: v.flags, returns: v.returns.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason, status: r.status, amount: r.amount, refund: r.refund })), disputes: v.disputes.map((d) => ({ id: d.id, reason: d.reason, status: d.status })) })),
      }
    }
    case 'trace_return': {
      const r = data.returns.find((x) => x.id === input.return_id)
      if (!r) throw new Error(`unknown return ${input.return_id}`)
      const o = vaults.order(r.order_id)!
      return { return: r, summary: vaults.summarizeReturn(r), delivery: o.fulfillment, order_lines: o.lines, expected_weight_g: r.carrier_inbound?.expected_weight_g }
    }
    case 'classify_session': {
      const v = vaultFor(String(input.order_id ?? ctx.orderId))
      if (!v) throw new Error(`unknown order ${input.order_id}`)
      return { population: v.population, score: v.population_score, signals: v.population_signals, agent_identity: v.agent_identity, session: v.session, payment: v.payment, ce3: v.ce3 }
    }
    case 'find_linked_accounts': {
      const v = vaultFor(String(input.order_id ?? ctx.orderId))
      if (!v) throw new Error(`unknown order ${input.order_id}`)
      const ids = new Set([...v.linkage.shared_device_customers, ...v.linkage.shared_address_customers, ...v.linkage.shared_payment_customers])
      return {
        linkage: v.linkage,
        linked_accounts: [...ids].map((id) => {
          const c = vaults.customer(id)!
          return { customer_id: id, name: c.name, account_created_at: c.account_created_at, history: vaults.history(id, vaults.now), orders: vaults.ordersFor(id).map((o) => ({ order_id: o.id, flags: vaultFor(o.id)!.flags })) }
        }),
      }
    }
    case 'inspect_claim': {
      if (input.return_id) {
        const r = data.returns.find((x) => x.id === input.return_id)
        if (!r) throw new Error(`unknown return ${input.return_id}`)
        return { kind: r.kind, via: r.via, requested_at: r.requested_at, reason: r.reason, claim_text: r.claim_text, photos: r.photos, summary: vaults.summarizeReturn(r) }
      }
      const d = data.disputes.find((x) => x.id === input.dispute_id)
      if (!d) throw new Error(`unknown dispute ${input.dispute_id}`)
      const rets = vaults.returnsFor(d.order_id).map((r) => ({ id: r.id, via: r.via, claim_text: r.claim_text, photos: r.photos, summary: vaults.summarizeReturn(r) }))
      return { dispute: vaults.summarizeDispute(d), related_returns: rets }
    }
    case 'attach_evidence': {
      const family = input.family as EvidenceFamily
      const allowed = FAMILIES_BY_ROLE[ctx.agent]
      if (!allowed.includes(family)) return { attached: null, rejected: `family "${family}" belongs to another specialist. You may only attach: ${allowed.join(', ')}. Skip this finding; the owning specialist covers it.` }
      const severity = (SEVERITIES.includes(input.severity as Severity) ? input.severity : 'info') as Severity
      const item = ctx.attach(ctx.agent, {
        family,
        label: String(input.label).slice(0, 80),
        detail: String(input.detail).slice(0, 600),
        severity,
        weight: clampWeight(severity, Number(input.weight)),
        node_ids: Array.isArray(input.node_ids) ? input.node_ids.map(String) : [ctx.orderId],
      })
      return item.id.startsWith('dup:') ? { attached: item.id.slice(4), note: 'near-duplicate of an existing finding; not attached again' } : { attached: item.id }
    }
    case 'issue_verdict':
      return ctx.verdict(input as never)
    case 'route_dispute':
      return ctx.route(input as never)
    default:
      throw new Error(`unknown tool ${name}`)
  }
}
