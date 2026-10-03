import type { EvidenceVault } from '@receipts/seed'
import { data } from '../store.js'

const STRIPE = 'https://api.stripe.com/v1'

function form(obj: Record<string, string | number | undefined>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
}

async function stripe<T>(path: string, body?: Record<string, string | number | undefined>): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY missing')
  const res = await fetch(`${STRIPE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Basic ' + Buffer.from(key + ':').toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body ? form(body) : undefined,
  })
  const json = (await res.json()) as T & { error?: { message: string } }
  if (!res.ok) throw new Error(`Stripe ${path}: ${json.error?.message ?? res.status}`)
  return json
}

/** Build the Stripe dispute `evidence` hash from the vault. Strings only, as the API expects. */
export function buildEvidencePackage(v: EvidenceVault, opts: { rationale: string; disputeReason: string }): Record<string, string> {
  const cust = data.customers.find((c) => c.id === v.customer_id)
  const addr = data.addresses.find((a) => a.id === v.visa_compelling_evidence_3?.disputed_transaction.shipping_address.line1) ?? data.addresses.find((a) => a.name === cust?.name)
  const refunded = v.returns.filter((r) => r.refund)
  const shipAddr = v.visa_compelling_evidence_3?.disputed_transaction.shipping_address
  const pkg: Record<string, string> = {
    product_description: v.lines.map((l) => `${l.name}${l.size ? ' ' + l.size : ''}${l.color ? ' ' + l.color : ''} x${l.qty} @ $${l.unit_price}`).join('; '),
    customer_name: v.customer_name,
    customer_email_address: v.confirmation_email.to,
    customer_purchase_ip: v.session.ip,
    billing_address: shipAddr ? `${shipAddr.line1}, ${shipAddr.city}, ${shipAddr.state} ${shipAddr.postal_code}, ${shipAddr.country}` : (addr ? `${addr.line1}, ${addr.city}, ${addr.state} ${addr.postal_code}` : ''),
    shipping_address: shipAddr ? `${shipAddr.line1}, ${shipAddr.city}, ${shipAddr.state} ${shipAddr.postal_code}, ${shipAddr.country}` : '',
    shipping_carrier: v.delivery.carrier,
    shipping_tracking_number: v.delivery.tracking,
    shipping_date: v.delivery.shipped_at.slice(0, 10),
    shipping_documentation: v.delivery.delivered_at ? `Delivered ${v.delivery.delivered_at.slice(0, 10)} with ${v.delivery.proof_of_delivery} proof; delivery address ${v.delivery.delivery_address_match ? 'matches' : 'does NOT match'} the order address.` : 'Not yet delivered.',
    refund_policy_disclosure: `Return policy ${v.policy_snapshot.version} (${v.policy_snapshot.return_window_days}-day window) presented and accepted at checkout ${v.policy_snapshot.accepted_at.slice(0, 19)}Z; ${v.policy_snapshot.url}`,
    refund_refusal_explanation: refunded.length
      ? refunded.map((r) => `Refund of $${r.refund!.amount.toFixed(2)} already issued ${r.refund!.issued_at.slice(0, 19)}Z (trigger: ${r.refund!.trigger}) for return ${r.id}${r.inbound_weight_ratio != null ? `; inbound parcel weight ${(r.inbound_weight_ratio * 100).toFixed(0)}% of expected` : ''}.`).join(' ')
      : opts.rationale,
    access_activity_log: `Session ${v.session.duration_s}s, ${v.session.pages} pages, ${v.session.hover_events} hover / ${v.session.scroll_events} scroll events, checkout ${(v.session.checkout_ms / 1000).toFixed(1)}s, IP ${v.session.ip} (${v.session.asn_org}), UA ${v.session.user_agent}. Confirmation email sent ${v.confirmation_email.sent_at.slice(0, 19)}Z to ${v.confirmation_email.to}.`,
    uncategorized_text: [
      `Dispute reason: ${opts.disputeReason}.`,
      `Order population: ${v.population} (score ${v.population_score}). ${v.population_signals.map((s) => s.detail).join(' ')}`,
      v.agent_identity?.visa_tap ? `Visa Trusted Agent Protocol token present: amr=[${v.agent_identity.visa_tap.amr.join(',')}], sub=${v.agent_identity.visa_tap.sub}, auth_time=${v.agent_identity.visa_tap.auth_time}.` : '',
      v.agent_identity?.ap2_mandate_hash ? `Signed cart mandate ${v.agent_identity.ap2_mandate_hash}.` : '',
      `CE 3.0: ${v.ce3.reason}`,
      `Screener rationale: ${opts.rationale}`,
    ].filter(Boolean).join(' '),
  }
  return pkg
}

export interface StagedDispute {
  stripe_dispute_id: string
  dashboard_url: string
  due_by: string
}

/**
 * Creates a real test-mode dispute (Stripe's pm_card_createDispute test card disputes immediately),
 * then stages the evidence with submit=false so it shows in the dashboard as a draft.
 */
/** Stripe dispute evidence fields that accept text. The others (shipping_documentation, receipt, ...) expect uploaded File ids. */
const TEXT_FIELDS = new Set(['product_description', 'customer_name', 'customer_email_address', 'customer_purchase_ip', 'billing_address', 'shipping_address', 'shipping_carrier', 'shipping_tracking_number', 'shipping_date', 'refund_policy_disclosure', 'refund_refusal_explanation', 'access_activity_log', 'uncategorized_text', 'cancellation_policy_disclosure', 'duplicate_charge_explanation', 'service_date', 'cancellation_rebuttal'])

export async function stageOnStripe(amountUsd: number, orderId: string, evidence: Record<string, string>): Promise<StagedDispute> {
  const pi = await stripe<{ id: string; latest_charge: string }>('/payment_intents', {
    amount: Math.round(amountUsd * 100),
    currency: 'usd',
    'payment_method_types[]': 'card',
    payment_method: 'pm_card_createDispute',
    confirm: 'true',
    description: `Receipts demo ${orderId}`,
    'metadata[order_id]': orderId,
  })
  let dispute: { id: string; evidence_details?: { due_by?: number } } | undefined
  for (let i = 0; i < 10 && !dispute; i++) {
    const list = await stripe<{ data: { id: string; evidence_details?: { due_by?: number } }[] }>(`/disputes?payment_intent=${pi.id}&limit=1`)
    dispute = list.data[0]
    if (!dispute) await new Promise((r) => setTimeout(r, 800))
  }
  if (!dispute) throw new Error('Stripe did not create a dispute for the test payment')
  const body: Record<string, string> = { submit: 'false' }
  const extra = Object.entries(evidence).filter(([k, v]) => v && !TEXT_FIELDS.has(k)).map(([k, v]) => `${k}: ${v}`)
  for (const [k, v] of Object.entries(evidence)) if (v && TEXT_FIELDS.has(k)) body[`evidence[${k}]`] = v.slice(0, 20_000)
  if (extra.length) body['evidence[uncategorized_text]'] = `${evidence.uncategorized_text ?? ''} ${extra.join(' ')}`.trim().slice(0, 20_000)
  const updated = await stripe<{ id: string; evidence_details?: { due_by?: number } }>(`/disputes/${dispute.id}`, body)
  const due = updated.evidence_details?.due_by ?? dispute.evidence_details?.due_by
  return {
    stripe_dispute_id: updated.id,
    dashboard_url: `https://dashboard.stripe.com/test/disputes/${updated.id}`,
    due_by: due ? new Date(due * 1000).toISOString() : new Date(Date.now() + 7 * 86_400_000).toISOString(),
  }
}
