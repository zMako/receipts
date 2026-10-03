# Signed-agent verifier (Web Bot Auth)

Phase 2 of Receipts. Every checkout is classified into one of four populations before the order is
written to the evidence vault: `signed`, `declared`, `undeclared-suspected`, `human`. The same
enum and the same signal weights are used by `VaultBuilder.classify()` in `packages/seed/src/vault.ts`,
so a live order and a seeded order with the same evidence land in the same bucket.

## Files

| file | role |
| --- | --- |
| `webBotAuth.ts` | `verifyAgentRequest()` middleware factory: parses, resolves keys, verifies Ed25519, enforces time window and nonce replay |
| `classifyRequest.ts` | unsigned path: `Agent/` UA -> `declared`; otherwise heuristics -> `human` or `undeclared-suspected` |
| `keys.ts` | Ed25519 key store for local test agents, `apps/server/.state/agent-keys.json`, generated on first use |
| `router.ts` | `GET /agents/:name/.well-known/http-message-signatures-directory`, `POST /api/checkout`, `GET /api/checkouts`, `setBroadcaster()` |
| `types.ts` | `AgentIdentityResult` (what lands on `req.agentIdentity`), allowed tags, telemetry shape |
| `index.ts` | barrel |

Test clients live in `apps/server/scripts/agents/` (`signed.ts`, `muse.ts`, `human.ts`, `all.ts`,
plus `standalone-server.ts` which mounts only this router).

## Wiring

```ts
import { verifyRouter, setBroadcaster } from './verify/index.js'
app.use(express.json())
app.use(verifyRouter)            // paths are absolute, mount at the app root
setBroadcaster(broadcast)        // from index.ts; avoids a circular import
```

`POST /api/checkout` with `{ customer_id, lines: [{ sku, qty, size?, color? }], telemetry?, payment_kind? }`
returns the contract's `checkout.observed` payload (plus a `detail` block with the full identity) and
broadcasts the payload on the live socket. `GET /api/checkouts` lists recent payloads newest first.

## How verification works

The protocol is IETF Web Bot Auth (`draft-ietf-webbotauth-httpsig-protocol`), a profile of RFC 9421
HTTP Message Signatures. The agent sends three headers:

```
Signature-Agent: "https://agent.example/agents/cartwright"
Signature-Input: sig1=("@authority" "@method" "@path" "signature-agent");created=1759500000;expires=1759500300;nonce="…";keyid="<jwk thumbprint>";alg="ed25519";tag="agent-payer-auth"
Signature: sig1=:<base64 Ed25519 signature>:
```

The verifier, in order (each step has a `reason` code that is attached to the result on failure):

1. **Headers present.** Both `Signature-Input` and `Signature` or neither (`signature_headers_incomplete`).
2. **Tag.** `tag` must be `web-bot-auth`, `agent-browser-auth` or `agent-payer-auth` (`tag_not_allowed`).
   If a request carries several signatures, the first one with an allowed tag is used.
3. **Time window.** `created` and `expires` are required integers. Reject `expires < now` (`expired`),
   `created > now + 60s` (`created_in_future`) and `expires - created > 600s` (`window_too_long`).
4. **Nonce.** Required (`nonce_missing`). After a successful signature check the `(keyid, nonce)` pair is
   stored in memory until `expires`; a second use is `nonce_replayed`. The store sweeps lazily.
5. **Signature-Agent.** Parsed with `web-bot-auth`'s `parseSignatureAgentHeader` (both the legacy
   sf-string and the current dictionary form). The signature must cover `signature-agent` (or the
   dictionary member it names) and bare `@authority` or `@target-uri`, as the draft requires.
6. **Key resolution.** `keyid` is an RFC 7638 JWK thumbprint. The JWK Set is read from
   `<Signature-Agent URI, no trailing slash>/.well-known/http-message-signatures-directory`. In-process
   overrides come first (`directoryOverrides` map and `addLocalDirectoryResolver()`; the router registers
   one so an agent served by this same host verifies without DNS or a self-fetch), then an HTTP fetch
   cached for 5 minutes (`directory_unreachable`, `directory_malformed`, `key_not_in_directory`).
7. **Ed25519.** `http-message-sig`'s `verifySignature` rebuilds the signature base from the live request
   (`@authority` from the Host header, so a signature minted for another host fails) and verifies with
   `web-bot-auth/crypto`'s `verifierFromJWK` (`signature_invalid`).

Why not `web-bot-auth`'s own `verify()`: it pins `tag` to `web-bot-auth`. Agent commerce uses the
browser and payer tags too, so the profile checks are reimplemented here on top of the same primitives.

## What lands on `req.agentIdentity`

```ts
{ population: 'signed', score: 1, verified: true, signature_agent, keyid, tag, created, expires, nonce, alg: 'ed25519', covered: [...], signals: [...] }
{ population: 'declared', score: 0.8, verified: false, reason: 'nonce_replayed', signature_agent, keyid, tag, ... }   // present but invalid
{ population: 'declared', score: 0.8, verified: false, signals: [declared_user_agent] }                            // Agent/ UA, no signature
{ population: 'undeclared-suspected' | 'human', score, verified: false, signals: [...] }                           // heuristics
```

The middleware never rejects a request. A present-but-invalid signature is classified `declared`
(the client claims an identity it cannot prove) with the failure reason, and the merchant decides.

## Unsigned classification

Same weights as the vault. Score >= 0.5 is `undeclared-suspected`.

| signal | weight | live source |
| --- | --- | --- |
| `sandbox_fingerprint_cluster` | 0.45 | `sec-ch-ua-platform: "Linux"` + Chrome UA (the Muse sandbox image); the detail counts customers seen per fingerprint this process |
| `cloud_egress` | 0.20 | `x-asn` header is 13335 (Cloudflare) or 54113 (Fastly). Dev only; production would resolve the client IP |
| `no_pointer_telemetry` | 0.15 | `x-receipts-telemetry` (or `body.telemetry`) `hover_events == 0 && scroll_events == 0` |
| `short_session` | 0.10 | `duration_s < 90` |
| `single_use_card` | 0.10 | `payment_kind == 'link_single_use'` in the body |
| `missing_accept_language` | 0.10 | no `Accept-Language` header (live-only signal; browsers always send one) |
| `straight_line_navigation` | 0.05 | `path == 'straight'` |
| `fast_checkout` | 0.05 | `checkout_ms < 10000` |

Telemetry header shape: `{"hover_events":0,"scroll_events":0,"duration_s":40,"path":"straight","checkout_ms":3000,"pages":2}`.

## Local test agents

`keys.ts` keeps one Ed25519 pair per agent name in `apps/server/.state/agent-keys.json`
(gitignored state). `GET /agents/cartwright/.well-known/http-message-signatures-directory` serves the
public JWK with `kid` = thumbprint and `Content-Type: application/http-message-signatures-directory+json`.

```
PORT=8790 npx tsx scripts/agents/standalone-server.ts          # or the full app
RECEIPTS_URL=http://localhost:8790 npx tsx scripts/agents/all.ts
```

## Limits

- **Signatures prove identity, not intent.** A verified `agent-payer-auth` signature says "this request
  was made by the holder of a key that `Signature-Agent` publishes". It does not say the human authorized
  this cart, this amount, or this merchant. That is what a Visa TAP token, an SPT with usage limits or an
  AP2 mandate adds; the vault stores those alongside the signature when present.
- **The directory is trusted on origin alone.** The draft also signs the directory response itself and
  expects HTTPS with a stable, reputable domain; this verifier fetches over plain HTTP in dev and does not
  verify the directory signature. A production deployment should pin known agent origins or allow-list them.
- **No body binding.** The test signature covers `@authority`, `@method`, `@path` and `signature-agent`.
  Adding `content-digest` would bind the cart; the server would then need the raw body to recompute it.
- **Nonce store is per process.** Replays across instances need a shared store (Redis) keyed by `(keyid, nonce)` with TTL = `expires`.
- **Heuristics are heuristics.** A Linux Chrome user with real pointer telemetry scores 0.45 and stays
  `human`; a headless session that fakes telemetry can score low. The point of the signal list is to
  record what the merchant saw at checkout, so the war room and the representment package can cite it.
- **Clock.** The verifier uses server time; agents more than 60 s fast are rejected as `created_in_future`.
