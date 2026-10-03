# Receipts — agent-era evidence vault and dispute war room

AI Commerce Gallery hackathon, Oct 3 2026. Submission deadline 5:00 PM PST.

## Concept

Shopper agents (Meta Muse, OpenAI Dots) look like ordinary browsers and erase the
evidence merchants use to win chargebacks. Receipts is a merchant-side ZooWork agent
system that (1) captures the right evidence per order at checkout, including agent
identity when it exists, (2) opens a multi-agent "war room" on every return request or
dispute where specialist agents gather evidence and a critic scores it, and (3) stages a
Stripe representment package or recommends refund-before-chargeback. A three.js evidence
graph is the live exhibit.

Pitch line: "The merchant's only lever is refunding before the chargeback is filed.
Today that's a guess. Receipts turns it into a scored decision."

## Stack

- Backend: Node 22, TypeScript, `@zoowork-ai/sdk` (agents), `@band-ai/sdk` (rooms), Stripe test mode.
- Frontend: Vite + three.js, WebSocket feed from backend. Hosted on localhost, Vercel if a link is required.
- Data: seeded merchant dataset (orders, customers, returns, carrier scans, disputes) in JSON. No real Shopify.
- Sponsors: ZooWork runs the agents, Band coordinates them, Entire tracks the repo, Moss optional for ring similarity.

## Phases

### Phase 0 — Scaffold (30 min)
- Git repo, `pnpm` monorepo: `apps/server`, `apps/exhibit`, `packages/seed`.
- Install SDKs, verify ZooWork key with `listModels()`, verify one Band agent connects.
- Entire trail created, first commit.
- Done when: server boots, one ZooWork agent answers a hello, Band room receives a message.

### Phase 1 — Seed data and evidence vault (45 min)
- Generate ~200 orders across three populations: human, signed agent, undeclared agent (Muse-like fingerprint: identical Linux Chrome, Cloudflare/Fastly egress, zero hover/scroll, straight-line checkout, fresh single-use Link card).
- Plant abuse patterns: serial returner, bracketing, empty-box (weight delta), double-dip (return + dispute on same charge), AI damage photo, multi-account ring (shared device/address).
- Vault schema per order: CE 3.0 fields for humans; signature key id, TAP token claims, SPT limits for agents; `agent_population` enum.
- Done when: `GET /orders/:id/evidence` returns a populated vault for any seeded order.

### Phase 2 — Signed-agent verifier (45 min)
- Express middleware: parse `Signature-Input` / `Signature` / `Signature-Agent`, require `tag` in web-bot-auth / agent-browser-auth / agent-payer-auth, resolve `keyid` against the agent's `/.well-known/http-message-signatures-directory`, enforce `created`/`expires` plus nonce store, verify Ed25519 with Cloudflare's `web-bot-auth` package.
- Two test clients: a signed agent (our own key directory) and an unsigned Muse-like Playwright session. Both hit the same checkout. Vault records different evidence for each.
- Done when: the demo script shows verified vs undeclared classification live.

### Phase 3 — War room (90 min)
- Five ZooWork agents, each bound to a Band identity: history, logistics, identity, forensics, critic. Each has custom tools reading the seed data and vault.
- Trigger: a return request or Stripe dispute webhook opens a Band room, posts the case, @mentions the specialists. Each posts findings. Critic scores and returns a tiered verdict: instant refund / exchange first / refund on inspection / require video / decline with policy citation.
- Dispute router: on a dispute, choose refund-and-close vs representment by VAMP impact; on representment, assemble the Stripe `evidence` hash and stage it with `submit=false`, surface `due_by`.
- Backend relays every ZooWork session event and Band message to the frontend over WebSocket.
- Done when: one seeded double-dip case runs end to end and produces a staged Stripe evidence package.

### Phase 4 — Three.js exhibit (90 min)
- Force-directed 3D graph: orders, customers, devices, addresses, cards as nodes. Population color-coded (human / signed / undeclared).
- When a war room opens, agent avatars fly to the case node and attach evidence edges as findings arrive. Suspicious edges glow. Ring clusters pull together.
- Side panel: live agent transcript, verdict tier, Stripe package preview, deadline countdown.
- Done when: the double-dip case plays as a 30-second visual story on a laptop.

### Phase 5 — Demo and submission (45 min)
- Demo script: signed vs unsigned agent at checkout, then the double-dip war room, then the ring reveal.
- Reset button to replay from clean state.
- README, 90-second pitch, screenshots, submission form before 5:00 PM.
- Product Hunt upvote screenshot for the gift.

## Cuts if behind
1. Drop Moss and ring detection; keep the graph but no clustering.
2. Fake the Stripe package from a template instead of calling the API.
3. Reduce war room to three agents: identity, logistics, critic.
4. Verifier demo with a recorded request instead of a live Playwright session.
