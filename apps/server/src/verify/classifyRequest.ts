/**
 * Classify an unsigned checkout request from request-observable signals only.
 * Mirrors the weights of `VaultBuilder.classify()` in packages/seed/src/vault.ts so a live order
 * and a seeded order land in the same population for the same evidence.
 */
import type { Request } from 'express'
import type { PopulationSignal } from '@receipts/seed'
import { createHash } from 'node:crypto'
import type { AgentIdentityResult, CheckoutTelemetry } from './types.js'

/** Copy of MUSE_UA in packages/seed/src/catalog.ts (not re-exported by the seed package index). */
export const MUSE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Same egress networks the vault treats as cloud: Cloudflare, Fastly. */
export const CLOUD_ASNS: Record<number, string> = { 13335: 'Cloudflare', 54113: 'Fastly' }
export const POPULATION_THRESHOLD = 0.5

/** Weights copied from vault.ts classify(); `missing_accept_language` is live-only (browsers always send it). */
export const WEIGHTS = {
  sandbox_fingerprint_cluster: 0.45,
  cloud_egress: 0.2,
  no_pointer_telemetry: 0.15,
  short_session: 0.1,
  single_use_card: 0.1,
  missing_accept_language: 0.1,
  straight_line_navigation: 0.05,
  fast_checkout: 0.05,
  declared_user_agent: 0.8,
} as const

/** Live counterpart of the seed's per-fingerprint session counter: how many distinct customers share each fingerprint. */
const fingerprintCustomers = new Map<string, Set<string>>()
const MAX_FINGERPRINTS = 10_000
const MAX_CUSTOMERS_PER_FINGERPRINT = 1000

function recordCustomer(fp: string, customerId: string): void {
  let set = fingerprintCustomers.get(fp)
  if (!set) {
    while (fingerprintCustomers.size >= MAX_FINGERPRINTS) fingerprintCustomers.delete(fingerprintCustomers.keys().next().value as string)
    set = new Set<string>()
    fingerprintCustomers.set(fp, set)
  }
  if (set.size < MAX_CUSTOMERS_PER_FINGERPRINT || set.has(customerId)) set.add(customerId)
}

/** Forget every fingerprint -> customers association (operator reset between demo runs). */
export function clearClassifierState(): void {
  fingerprintCustomers.clear()
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()]
  if (Array.isArray(v)) return v.join(', ')
  return typeof v === 'string' && v.length ? v : undefined
}

function sfString(v: string | undefined): string | undefined {
  if (!v) return undefined
  const m = /^"(.*)"$/.exec(v.trim())
  return m ? m[1] : v.trim()
}

export function readTelemetry(req: Request): CheckoutTelemetry | undefined {
  const raw = header(req, 'x-receipts-telemetry')
  let t: unknown
  if (raw) {
    try {
      t = JSON.parse(raw)
    } catch {
      t = undefined
    }
  }
  if (!t && req.body && typeof req.body === 'object' && 'telemetry' in req.body) t = (req.body as { telemetry?: unknown }).telemetry
  if (!t || typeof t !== 'object') return undefined
  const o = t as Record<string, unknown>
  const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined)
  const hover = num('hover_events')
  const scroll = num('scroll_events')
  const duration = num('duration_s')
  const checkout = num('checkout_ms')
  if (hover === undefined || scroll === undefined || duration === undefined || checkout === undefined) return undefined
  return { hover_events: hover, scroll_events: scroll, duration_s: duration, checkout_ms: checkout, path: o.path === 'straight' ? 'straight' : 'browse', pages: num('pages') }
}

/** A stable fingerprint of what the browser tells us, the live analogue of `Device.fingerprint`. */
export function requestFingerprint(req: Request): string {
  const parts = [header(req, 'user-agent') ?? '', header(req, 'sec-ch-ua') ?? '', header(req, 'sec-ch-ua-platform') ?? '', header(req, 'sec-ch-ua-mobile') ?? '', header(req, 'accept-language') ?? '']
  return 'fp_' + createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12)
}

export interface ClassifyOptions {
  /** Customer id from a *validated* checkout body; used only to count distinct customers per fingerprint. Omit to classify without recording. */
  customerId?: string
  /** Payment instrument kind if the merchant already knows it (the vault scores single-use Link cards). */
  paymentKind?: string
}

export function classifyRequest(req: Request, opts: ClassifyOptions = {}): AgentIdentityResult {
  const signals: PopulationSignal[] = []
  const ua = header(req, 'user-agent') ?? ''

  if (ua.startsWith('Agent/')) {
    signals.push({ signal: 'declared_user_agent', detail: `UA declares ${ua.split(' ')[0]} but no request signature`, weight: WEIGHTS.declared_user_agent })
    return { population: 'declared', score: WEIGHTS.declared_user_agent, signals, verified: false }
  }

  let score = 0
  const hit = (signal: keyof typeof WEIGHTS, detail: string) => {
    signals.push({ signal, detail, weight: WEIGHTS[signal] })
    score += WEIGHTS[signal]
  }

  const platform = sfString(header(req, 'sec-ch-ua-platform'))
  const chUa = header(req, 'sec-ch-ua') ?? ''
  const isChrome = /Chrome\/\d+/.test(ua) && !/Edg\/|OPR\//.test(ua)
  const linuxChrome = platform === 'Linux' && isChrome && (chUa === '' || /Chromium|Google Chrome/.test(chUa))
  const fp = requestFingerprint(req)
  if (opts.customerId) recordCustomer(fp, opts.customerId)
  const shared = fingerprintCustomers.get(fp)?.size ?? 1
  if (linuxChrome) {
    const sameImage = ua === MUSE_UA ? 'identical to the Muse sandbox image' : 'headless-style Linux Chrome'
    hit('sandbox_fingerprint_cluster', `Client hints say Linux + Chrome (${sameImage}); fingerprint ${fp} seen for ${shared} customer${shared === 1 ? '' : 's'} this session`)
  }

  const asnRaw = header(req, 'x-asn')
  const asn = asnRaw ? Number.parseInt(asnRaw.replace(/^AS/i, ''), 10) : NaN
  if (Number.isFinite(asn) && CLOUD_ASNS[asn]) hit('cloud_egress', `Egress declared as ${CLOUD_ASNS[asn]} (AS${asn}), not a residential network (x-asn header, dev only)`)

  const t = readTelemetry(req)
  if (t) {
    if (t.hover_events === 0 && t.scroll_events === 0) hit('no_pointer_telemetry', 'Zero hover and zero scroll events for the whole session')
    if (t.path === 'straight') hit('straight_line_navigation', `${t.pages ?? 2} pages, landed directly on product then checkout`)
    if (t.duration_s < 90) hit('short_session', `Session lasted ${t.duration_s}s`)
    if (t.checkout_ms < 10_000) hit('fast_checkout', `Checkout form completed in ${(t.checkout_ms / 1000).toFixed(1)}s`)
  } else {
    signals.push({ signal: 'no_telemetry', detail: 'No x-receipts-telemetry header or body.telemetry; pointer and timing signals unavailable', weight: 0 })
  }

  if (!header(req, 'accept-language')) hit('missing_accept_language', 'Request carries no Accept-Language header; every mainstream browser sends one')
  if (opts.paymentKind === 'link_single_use') hit('single_use_card', 'Fresh Link single-use card bound to this order')

  score = Math.min(1, Math.round(score * 100) / 100)
  return { population: score >= POPULATION_THRESHOLD ? 'undeclared-suspected' : 'human', score, signals, verified: false }
}
