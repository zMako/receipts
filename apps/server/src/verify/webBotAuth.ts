/**
 * Web Bot Auth verifier (draft-ietf-webbotauth-httpsig-protocol on RFC 9421 HTTP Message Signatures).
 *
 * `verifyAgentRequest()` is an Express middleware factory. It never rejects a request: it attaches
 * `req.agentIdentity` and lets the merchant decide. Three outcomes:
 *   - signature present and valid      -> population 'signed', verified: true
 *   - signature present but invalid    -> population 'declared' (claims an identity it cannot prove), verified: false, reason
 *   - no signature                     -> 'declared' (UA starts with "Agent/") or 'human' / 'undeclared-suspected' from classifyRequest()
 *
 * The RFC 9421 parsing, signature-base construction and Ed25519 verification come from `http-message-sig`;
 * the Web Bot Auth profile pieces (Signature-Agent parsing, JWK thumbprint keyids, nonces) from `web-bot-auth`.
 * `web-bot-auth`'s own `verify()` pins `tag` to "web-bot-auth"; agent commerce also uses
 * `agent-browser-auth` and `agent-payer-auth`, so the profile checks are implemented here instead.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { isSignatureError, verifySignature, type RequestDescriptor, type FieldOccurrence } from 'http-message-sig'
import { HTTP_MESSAGE_SIGNATURES_DIRECTORY, parseSignatureAgentHeader, type JSONWebKeySet, type SignatureAgentEntry } from 'web-bot-auth'
import { verifierFromJWK } from 'web-bot-auth/crypto'
import { parseDictionary, type InnerList, type Parameters } from 'structured-headers'
import { classifyRequest } from './classifyRequest.js'
import { WEB_BOT_AUTH_TAGS, type AgentIdentityResult, type Jwk, type WebBotAuthTag } from './types.js'

/** Reject `created` more than this many seconds in the future. */
export const MAX_CREATED_SKEW_S = 60
/** Reject signatures whose `expires - created` exceeds this. */
export const MAX_WINDOW_S = 600
/** Directory cache lifetime. */
export const DIRECTORY_TTL_MS = 5 * 60_000
const DIRECTORY_FETCH_TIMEOUT_MS = 4000

export type VerifyFailureReason =
  | 'signature_headers_incomplete'
  | 'signature_input_malformed'
  | 'tag_not_allowed'
  | 'keyid_missing'
  | 'alg_unsupported'
  | 'timestamps_missing'
  | 'created_after_expires'
  | 'created_in_future'
  | 'expired'
  | 'window_too_long'
  | 'nonce_missing'
  | 'nonce_malformed'
  | 'nonce_replayed'
  | 'signature_agent_missing'
  | 'signature_agent_malformed'
  | 'signature_agent_not_covered'
  | 'signature_agent_type_unsupported'
  | 'authority_not_covered'
  | 'directory_unreachable'
  | 'directory_malformed'
  | 'key_not_in_directory'
  | 'signature_invalid'
  | 'verification_error'

// ---------- nonce store ----------

const nonces = new Map<string, number>()
let lastSweep = 0
function sweepNonces(now: number): void {
  if (now - lastSweep < 30_000 && nonces.size < 5000) return
  lastSweep = now
  for (const [k, exp] of nonces) if (exp <= now) nonces.delete(k)
}
export const nonceStore = {
  /** Returns false if the nonce was already seen for this key. */
  claim(keyid: string, nonce: string, expiresAtMs: number, nowMs = Date.now()): boolean {
    sweepNonces(nowMs)
    const k = `${keyid}\n${nonce}`
    const seen = nonces.get(k)
    if (seen !== undefined && seen > nowMs) return false
    nonces.set(k, expiresAtMs)
    return true
  },
  size(): number {
    return nonces.size
  },
  clear(): void {
    nonces.clear()
  },
}

// ---------- key directory resolution ----------

type DirectoryResolver = (agentUri: URL, req: Request) => JSONWebKeySet | undefined | Promise<JSONWebKeySet | undefined>
/** Static overrides keyed by normalized agent URI (no trailing slash), e.g. "http://localhost:8787/agents/cartwright". */
export const directoryOverrides = new Map<string, JSONWebKeySet>()
const resolvers: DirectoryResolver[] = []
/** Register an in-process resolver so an agent served by this same server verifies without DNS or a self-fetch. */
export function addLocalDirectoryResolver(fn: DirectoryResolver): void {
  resolvers.push(fn)
}

const directoryCache = new Map<string, { jwks: JSONWebKeySet; fetched_at: number }>()
export function clearDirectoryCache(): void {
  directoryCache.clear()
}

export function normalizeAgentUri(uri: string): string {
  const u = new URL(uri)
  return u.origin + u.pathname.replace(/\/+$/, '')
}

/** `<agent origin or path prefix>/.well-known/http-message-signatures-directory`. */
export function directoryUrlFor(agentUri: string): string {
  return normalizeAgentUri(agentUri) + HTTP_MESSAGE_SIGNATURES_DIRECTORY
}

function isJwks(v: unknown): v is JSONWebKeySet {
  return !!v && typeof v === 'object' && Array.isArray((v as { keys?: unknown }).keys)
}

async function fetchDirectory(url: string, nowMs: number): Promise<{ jwks?: JSONWebKeySet; reason?: VerifyFailureReason; detail?: string }> {
  const hit = directoryCache.get(url)
  if (hit && nowMs - hit.fetched_at < DIRECTORY_TTL_MS) return { jwks: hit.jwks }
  try {
    const res = await fetch(url, { headers: { accept: 'application/http-message-signatures-directory+json, application/json' }, signal: AbortSignal.timeout(DIRECTORY_FETCH_TIMEOUT_MS) })
    if (!res.ok) return { reason: 'directory_unreachable', detail: `${url} answered ${res.status}` }
    const body: unknown = await res.json()
    if (!isJwks(body)) return { reason: 'directory_malformed', detail: `${url} is not a JWK Set` }
    directoryCache.set(url, { jwks: body, fetched_at: nowMs })
    return { jwks: body }
  } catch (e) {
    return { reason: 'directory_unreachable', detail: `${url}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function resolveDirectory(agentUri: URL, req: Request, nowMs: number): Promise<{ jwks?: JSONWebKeySet; reason?: VerifyFailureReason; detail?: string }> {
  const key = normalizeAgentUri(agentUri.href)
  const override = directoryOverrides.get(key)
  if (override) return { jwks: override }
  for (const r of resolvers) {
    const jwks = await r(agentUri, req)
    if (jwks) return { jwks }
  }
  return fetchDirectory(directoryUrlFor(agentUri.href), nowMs)
}

async function findKey(jwks: JSONWebKeySet, keyid: string): Promise<Jwk | undefined> {
  const ed = (jwks.keys as Jwk[]).filter((k) => k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string')
  for (const k of ed) {
    try {
      if ((await verifierFromJWK(k)).keyid === keyid) return k
    } catch {
      /* skip unparseable keys */
    }
  }
  return ed.find((k) => k.kid === keyid)
}

// ---------- request descriptor ----------

export function describeRequest(req: Request): RequestDescriptor {
  const fields: FieldOccurrence[] = []
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) fields.push({ name, value: v })
    else fields.push({ name, value })
  }
  const host = req.get('host') ?? 'localhost'
  return { kind: 'request', method: req.method, targetUri: `${req.protocol}://${host}${req.originalUrl}`, requestTarget: req.originalUrl, fields }
}

function headerString(req: Request, name: string): string | undefined {
  const v = req.headers[name]
  if (Array.isArray(v)) return v.join(', ')
  return v
}

// ---------- Signature-Input pre-parse (diagnostics; http-message-sig re-parses strictly) ----------

interface ParsedInput {
  label: string
  components: { name: string; params: Parameters }[]
  params: Parameters
}

function preParseSignatureInput(raw: string): ParsedInput[] | undefined {
  try {
    const dict = parseDictionary(raw)
    const out: ParsedInput[] = []
    for (const [label, member] of dict) {
      if (!Array.isArray(member[0])) return undefined
      const [items, params] = member as InnerList
      out.push({ label, components: items.map(([name, p]) => ({ name: String(name), params: p })), params })
    }
    return out
  } catch {
    return undefined
  }
}

const isAllowedTag = (t: unknown): t is WebBotAuthTag => typeof t === 'string' && (WEB_BOT_AUTH_TAGS as readonly string[]).includes(t)

// ---------- the verifier ----------

export interface VerifyAgentOptions {
  /** Injectable clock, seconds since epoch. */
  now?: () => number
}

/**
 * Verify a Web Bot Auth signature on `req`. Returns undefined when the request carries no signature headers at all.
 * Never throws for bad input; a present-but-invalid signature yields `verified: false` with a `reason`.
 */
export async function verifySignedRequest(req: Request, opts: VerifyAgentOptions = {}): Promise<AgentIdentityResult | undefined> {
  const sigInput = headerString(req, 'signature-input')
  const sig = headerString(req, 'signature')
  const sigAgentRaw = headerString(req, 'signature-agent')
  if (!sigInput && !sig) return undefined

  const nowS = opts.now ? opts.now() : Math.floor(Date.now() / 1000)
  const nowMs = nowS * 1000
  const partial: Partial<AgentIdentityResult> = { signature_agent: sigAgentRaw?.replace(/^"|"$/g, '') }
  const fail = (reason: VerifyFailureReason, detail: string): AgentIdentityResult => ({
    population: 'declared',
    score: 0.8,
    signals: [{ signal: 'signature_invalid', detail: `Signature present but not verified (${reason}): ${detail}`, weight: 0.8 }],
    verified: false,
    reason,
    ...partial,
  })

  if (!sigInput || !sig) return fail('signature_headers_incomplete', 'both Signature-Input and Signature are required')
  const parsed = preParseSignatureInput(sigInput)
  if (!parsed || parsed.length === 0) return fail('signature_input_malformed', 'Signature-Input is not an RFC 8941 dictionary of inner lists')

  // Pick the first label whose tag is one of ours; a request may carry other, unrelated signatures.
  const candidate = parsed.find((p) => isAllowedTag(p.params.get('tag'))) ?? parsed[0]!
  const p = candidate.params
  const tag = p.get('tag')
  partial.tag = typeof tag === 'string' ? tag : undefined
  partial.keyid = typeof p.get('keyid') === 'string' ? (p.get('keyid') as string) : undefined
  partial.alg = typeof p.get('alg') === 'string' ? (p.get('alg') as string) : undefined
  partial.created = typeof p.get('created') === 'number' ? (p.get('created') as number) : undefined
  partial.expires = typeof p.get('expires') === 'number' ? (p.get('expires') as number) : undefined
  partial.nonce = typeof p.get('nonce') === 'string' ? (p.get('nonce') as string) : undefined
  partial.covered = candidate.components.map((c) => (c.params.size ? `${c.name};${[...c.params].map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(';')}` : c.name))

  if (!isAllowedTag(tag)) return fail('tag_not_allowed', `tag=${tag === undefined ? '(absent)' : String(tag)}; expected one of ${WEB_BOT_AUTH_TAGS.join(', ')}`)
  if (!partial.keyid) return fail('keyid_missing', 'keyid parameter must be a non-empty string')
  if (partial.alg !== undefined && partial.alg !== 'ed25519') return fail('alg_unsupported', `alg=${partial.alg}; only ed25519 is accepted`)
  const { created, expires } = partial
  if (created === undefined || expires === undefined || !Number.isInteger(created) || !Number.isInteger(expires)) return fail('timestamps_missing', 'created and expires must both be integer seconds')
  if (created > expires) return fail('created_after_expires', `created ${created} > expires ${expires}`)
  if (created > nowS + MAX_CREATED_SKEW_S) return fail('created_in_future', `created is ${created - nowS}s ahead of server time (max ${MAX_CREATED_SKEW_S}s)`)
  if (expires < nowS) return fail('expired', `expired ${nowS - expires}s ago`)
  if (expires - created > MAX_WINDOW_S) return fail('window_too_long', `validity window ${expires - created}s exceeds ${MAX_WINDOW_S}s`)
  if (!partial.nonce) return fail('nonce_missing', 'nonce parameter is required for replay protection')
  if (partial.nonce.length > 512 || !/^[A-Za-z0-9+/=_-]+$/.test(partial.nonce)) return fail('nonce_malformed', 'nonce must be base64 or base64url')

  if (!sigAgentRaw) return fail('signature_agent_missing', 'Signature-Agent header is required')
  let agentEntry: SignatureAgentEntry
  try {
    const sa = parseSignatureAgentHeader(sigAgentRaw)
    if (sa.kind === 'legacy') {
      if (!candidate.components.some((c) => c.name === 'signature-agent' && c.params.size === 0)) return fail('signature_agent_not_covered', 'signature must cover the signature-agent field')
      agentEntry = sa.entries[0]!
    } else {
      const keyed = candidate.components.filter((c) => c.name === 'signature-agent' && typeof c.params.get('key') === 'string')
      if (keyed.length !== 1) return fail('signature_agent_not_covered', 'signature must cover exactly one signature-agent dictionary member')
      const key = keyed[0]!.params.get('key') as string
      const entry = sa.entries.find((e) => e.label === key)
      if (!entry) return fail('signature_agent_not_covered', `Signature-Agent has no member ${key}`)
      agentEntry = entry
    }
  } catch (e) {
    return fail('signature_agent_malformed', e instanceof Error ? e.message : String(e))
  }
  partial.signature_agent = agentEntry.uri
  if (agentEntry.type !== 'directory') return fail('signature_agent_type_unsupported', `discovery type ${agentEntry.type} is not supported; use a key directory`)
  if (!candidate.components.some((c) => (c.name === '@authority' || c.name === '@target-uri') && c.params.size === 0)) return fail('authority_not_covered', 'signature must cover bare @authority or @target-uri')

  let agentUrl: URL
  try {
    agentUrl = new URL(agentEntry.uri)
  } catch {
    return fail('signature_agent_malformed', `${agentEntry.uri} is not a URL`)
  }
  const dir = await resolveDirectory(agentUrl, req, nowMs)
  if (!dir.jwks) return fail(dir.reason ?? 'directory_unreachable', dir.detail ?? 'no key directory')
  const jwk = await findKey(dir.jwks, partial.keyid)
  if (!jwk) return fail('key_not_in_directory', `keyid ${partial.keyid.slice(0, 12)}… not published at ${directoryUrlFor(agentEntry.uri)}`)

  try {
    const verified = await verifySignature(describeRequest(req), {
      label: candidate.label,
      policy: { algorithms: ['ed25519'], requiredComponents: [], requiredParameters: ['created', 'expires', 'keyid', 'tag'], maxAge: MAX_WINDOW_S, clockSkew: MAX_CREATED_SKEW_S, now: nowS },
      resolveVerifier: () => verifierFromJWK(jwk),
    })
    const vp = verified.parameters
    const vNonce = typeof vp.nonce === 'string' ? vp.nonce : partial.nonce
    const vCreated = typeof vp.created === 'number' ? vp.created : created
    const vExpires = typeof vp.expires === 'number' ? vp.expires : expires
    if (!nonceStore.claim(partial.keyid, vNonce, Math.min(vExpires, nowS + MAX_WINDOW_S) * 1000, nowMs)) return fail('nonce_replayed', `nonce ${vNonce.slice(0, 10)}… already used by this key within its validity window`)
    const covered = verified.components.map((c) => (Object.keys(c.parameters).length ? `${c.name};${Object.entries(c.parameters).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(';')}` : c.name))
    return {
      population: 'signed',
      score: 1,
      signals: [{ signal: 'web_bot_auth_verified', detail: `Ed25519 signature verified against ${agentEntry.uri} (keyid ${partial.keyid.slice(0, 8)}…, tag=${tag}); covers ${covered.join(', ')}`, weight: 1 }],
      verified: true,
      signature_agent: agentEntry.uri,
      keyid: partial.keyid,
      tag,
      created: vCreated,
      expires: vExpires,
      nonce: vNonce,
      alg: 'ed25519',
      covered,
    }
  } catch (e) {
    if (isSignatureError(e)) {
      const reason: VerifyFailureReason = e.code === 'VerificationFailed' ? 'signature_invalid' : e.code === 'PolicyViolation' ? (e.message.includes('expired') ? 'expired' : e.message.includes('future') ? 'created_in_future' : 'verification_error') : 'verification_error'
      const cause = e.cause instanceof Error ? `: ${e.cause.message}` : ''
      return fail(reason, `${e.code}: ${e.message}${cause}`)
    }
    return fail('verification_error', e instanceof Error ? e.message : String(e))
  }
}

/** Express middleware: attaches `req.agentIdentity` and always calls next(). */
export function verifyAgentRequest(opts: VerifyAgentOptions = {}): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    verifySignedRequest(req, opts)
      .then((signed) => {
        const body = (req.body ?? {}) as { customer_id?: unknown; payment_kind?: unknown }
        req.agentIdentity =
          signed ??
          classifyRequest(req, {
            customerId: typeof body.customer_id === 'string' ? body.customer_id : undefined,
            paymentKind: typeof body.payment_kind === 'string' ? body.payment_kind : undefined,
          })
        next()
      })
      .catch((e: unknown) => {
        req.agentIdentity = { population: 'declared', score: 0.8, signals: [{ signal: 'signature_invalid', detail: `verifier error: ${e instanceof Error ? e.message : String(e)}`, weight: 0.8 }], verified: false, reason: 'verification_error' }
        next()
      })
  }
}
