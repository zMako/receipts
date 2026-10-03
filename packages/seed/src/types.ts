export type AgentPopulation = 'human' | 'signed' | 'declared' | 'undeclared-suspected'
export type Channel = 'web' | 'muse' | 'dots' | 'signed-agent' | 'declared-agent'

export interface Product {
  sku: string
  name: string
  category: string
  price: number
  weight_g: number
  sizes?: string[]
  colors?: string[]
  /** Attribute ambiguity an agent could misread (the Rufus pattern). */
  ambiguity?: string
}

export interface Address {
  id: string
  name: string
  line1: string
  city: string
  state: string
  postal_code: string
  country: string
}

export interface Device {
  id: string
  fingerprint: string
  platform: string
  browser: string
  hardware: string
  /** Identical across every Muse session: one sandbox image. */
  cluster?: 'muse-sandbox' | 'dots-sandbox' | 'agent-runtime'
}

export interface PaymentInstrument {
  id: string
  kind: 'card' | 'link_single_use' | 'shop_pay' | 'spt'
  brand: 'visa' | 'mastercard' | 'amex'
  last4: string
  bin: string
  name_on_card: string
}

export interface Customer {
  id: string
  name: string
  email: string
  account_created_at: string
  address_ids: string[]
  device_ids: string[]
  tags: string[]
}

export interface OrderLine {
  sku: string
  name: string
  size?: string
  color?: string
  qty: number
  unit_price: number
  weight_g: number
}

export interface SessionTelemetry {
  ip: string
  asn: number
  asn_org: string
  device_id: string
  user_agent: string
  duration_s: number
  pages: number
  hover_events: number
  scroll_events: number
  path: 'browse' | 'straight'
  checkout_ms: number
}

export interface WebBotAuth {
  signature_agent: string
  keyid: string
  tag: 'web-bot-auth' | 'agent-browser-auth' | 'agent-payer-auth'
  created: number
  expires: number
  nonce: string
  alg: 'ed25519'
  verified: boolean
}

export interface VisaTapToken {
  sub: string
  amr: string[]
  auth_time: number
  kid: string
  iss: string
}

export interface SharedPaymentToken {
  token: string
  seller: string
  usage_limits: { amount: number; currency: string; expires_at: string }
  deactivated_reason: string | null
}

export interface AgentIdentity {
  declared_user_agent?: string
  web_bot_auth?: WebBotAuth
  visa_tap?: VisaTapToken
  spt?: SharedPaymentToken
  ap2_mandate_hash?: string
  ucp_agent_profile?: string
}

export interface Order {
  id: string
  charge_id: string
  customer_id: string
  placed_at: string
  channel: Channel
  lines: OrderLine[]
  subtotal: number
  shipping: number
  total: number
  currency: 'usd'
  shipping_address_id: string
  billing_address_id: string
  payment: PaymentInstrument
  session: SessionTelemetry
  agent_identity?: AgentIdentity
  fulfillment: {
    carrier: 'UPS' | 'USPS' | 'FedEx'
    tracking: string
    shipped_at: string
    delivered_at: string | null
    proof_of_delivery: 'scan' | 'photo' | 'signature' | null
    delivery_address_match: boolean
  }
  confirmation_email: { sent_at: string; to: string; subject: string }
  policy_snapshot: { version: string; return_window_days: number; accepted_at: string; url: string }
  /** Planted scenario tags for the demo. Not visible to agents' scoring. */
  scenario?: string[]
}

export interface ClaimPhoto {
  id: string
  filename: string
  exif_present: boolean
  camera_model: string | null
  generator_watermark: boolean
  duplicated_region_score: number
  taken_at: string | null
}

export interface ReturnRequest {
  id: string
  order_id: string
  customer_id: string
  kind: 'return' | 'inr_claim' | 'damage_claim'
  requested_at: string
  reason: string
  claim_text: string
  lines: { sku: string; size?: string; qty: number; amount: number }[]
  amount: number
  photos: ClaimPhoto[]
  via: 'portal' | 'email' | 'agent'
  status: 'requested' | 'label_issued' | 'in_transit' | 'received' | 'refunded' | 'declined'
  carrier_inbound: {
    tracking: string
    first_scan_at: string | null
    received_at: string | null
    inbound_weight_g: number | null
    expected_weight_g: number
  } | null
  refund: { amount: number; issued_at: string; trigger: 'carrier_scan' | 'inspection' | 'manual' | 'instant' } | null
  scenario?: string[]
}

export interface Dispute {
  id: string
  charge_id: string
  order_id: string
  network: 'visa' | 'mastercard'
  reason: 'fraudulent' | 'product_not_received' | 'product_unacceptable' | 'credit_not_processed' | 'duplicate' | 'unrecognized'
  reason_code: string
  amount: number
  is_inquiry: boolean
  status: 'warning_needs_response' | 'needs_response' | 'under_review' | 'won' | 'lost'
  created_at: string
  evidence_due_by: string
  cardholder_statement: string
  scenario?: string[]
}

export interface Merchant {
  name: string
  domain: string
  platform: string
  return_policy: { version: string; window_days: number; url: string; text: string }
  stripe_account: string
  vamp: { window: string; tc05: number; tc40: number; tc15: number; threshold: number }
}

export interface Dataset {
  generated_at: string
  merchant: Merchant
  products: Product[]
  addresses: Address[]
  devices: Device[]
  customers: Customer[]
  orders: Order[]
  returns: ReturnRequest[]
  disputes: Dispute[]
  heroes: Record<string, string>
}
