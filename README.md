# Receipts

**An agent-era evidence vault and dispute war room for merchants.**
Built in one day at the AI Commerce Gallery hackathon (ZooWork x AI Valley, October 3, 2026).

> The shopper now has an agent. Meta Muse and OpenAI Dots arrive at checkout as plain Chromium
> browsers: no signature, no agent header, no customer-identifying device or IP. That erases the
> exact evidence merchants use to win chargebacks under Visa Compelling Evidence 3.0, while
> Shopify auto-enrolled every US store into agent checkout and half of consumers already draft
> return claims with GenAI. The merchant's only lever is refunding before the chargeback is filed.
> Today that is a guess. Receipts turns it into a scored decision.

## What it does

1. **Evidence vault at checkout.** Every order is classified into a population using only what the
   merchant observed at checkout: `signed` (Web Bot Auth signature verified against the agent's key
   directory, Visa Trusted Agent Protocol token, shared payment token, mandate), `declared`
   (`Agent/` user agent, no signature), `undeclared-suspected` (Muse-like: a sandbox fingerprint shared
   by dozens of sessions, Cloudflare or Fastly egress, zero pointer telemetry, straight-line checkout,
   single-use Link card) or `human`. The vault stores CE 3.0 fields for humans and the replacement
   identity evidence for agents, plus delivery proof, policy snapshot and confirmation email.
2. **Signed-agent verifier.** An Express middleware implementing the IETF Web Bot Auth draft on
   RFC 9421 HTTP Message Signatures: parses `Signature-Input`, `Signature`, `Signature-Agent`, resolves
   the key id against `/.well-known/http-message-signatures-directory`, enforces `created` / `expires`
   and a nonce store, verifies Ed25519. Test clients play a signed agent, a Muse-like unsigned
   browser and a human against the same checkout.
3. **War room.** A return request or Stripe dispute opens a case. Five ZooWork agents, each bound to
   a Band identity, coordinate in a Band room: the Critic posts the brief and @mentions History,
   Logistics, Identity and Forensics; each pulls evidence with its own tools, attaches findings to the
   case file and replies through the room; the Critic weighs everything and issues a tiered verdict:
   instant refund, exchange first, refund on inspection, require verification, or decline with a policy
   citation.
4. **Dispute router.** For disputes it optimises Visa VAMP exposure rather than win rate: refund and
   close an inquiry when that is cheaper than a VAMP item, represent when the vault holds a prior
   refund plus delivery proof, CE 3.0 qualifying history, or a passkey-authenticated agent token. When
   it represents, it creates the dispute in Stripe test mode and stages the evidence package with
   `submit=false`, so a human approves in the dashboard.
5. **Exhibit.** A three.js force graph of orders, customers, devices, addresses, cards, returns and
   disputes. Agents fly to the case node and attach evidence live; ring clusters pull together; the
   side panel shows the transcript, verdict, routing, VAMP arithmetic and the staged Stripe package
   with a countdown to the evidence deadline.

## Stack and sponsors

| Piece | Technology |
|---|---|
| Agents | [ZooWork Managed Agents](https://zoowork.ai) via `@zoowork-ai/sdk`: five agents with application-executed custom tools over the vault |
| Coordination | [Band](https://band.ai) rooms and @mentions through the Agent REST API; five registered Band identities |
| Build provenance | [Entire](https://entire.io) mirrors the repo and attaches every Claude Code session to its commits |
| Payments | Stripe test mode: disputes created with `pm_card_createDispute`, evidence staged unsubmitted |
| Verifier | `web-bot-auth` and `http-message-sig` (Cloudflare, Apache-2.0), Ed25519 via Node crypto |
| Exhibit | three.js, 3d-force-graph, UnrealBloomPass, Vite |
| Data | Deterministic seeded dataset: 236 orders, 75 customers, 38 returns, 10 disputes, planted abuse patterns |

## Run it

```bash
cp .env.example .env   # fill in ZOOWORK_API_KEY, the five BAND_* pairs, STRIPE_SECRET_KEY (test)
npm install
npm run verify         # checks ZooWork models and the five Band identities in the room
npm run dev            # server on :8787, provisions agents, starts the Band bridge
npm run exhibit        # exhibit on :5173 (proxies /api and /live to the server)
```

Open http://localhost:5173. The exhibit autoplays the offline replay of the double-dip case, then idles.
Press **L** (or click *Run live*) to open `dp_doubledip` in a real war room; **R** replays offline;
**Esc** resets.

Signed versus unsigned agents at checkout:

```bash
cd apps/server && npx tsx scripts/agents/all.ts
```

## Planted cases

| Id | Story | Expected outcome |
|---|---|---|
| `dp_doubledip` | Muse-like order, refund fired on the carrier's first scan, then a "my AI assistant did it" chargeback on the same charge | decline, represent, staged on Stripe |
| `ret_aiphoto` | Nine-day-old account, damage claim with generator-watermarked photos and policy-lawyer wording | decline |
| `ret_emptybox` | Boots returned, parcel weighs 180 g against 1,450 g expected, refund on first scan | decline |
| `ret_loyal_defect` | 640-day VIP, one genuine seam failure with real photos, asks for an exchange | exchange first or instant refund |
| `dp_signed` | Signed agent order with passkey-authenticated Visa TAP token and mandate, disputed as fraud | represent with the token as evidence |
| ring (`addr_ring`) | Five accounts sharing two devices and one address, item-not-received claims | ring linkage flagged on every order |

## Honest limits

- The dataset is synthetic. Muse and Dots behaviour is modelled on published research (DataDome's
  fingerprint analysis, Amazon's block notice, Shopify's agentic storefront docs), not on captured
  traffic.
- Signatures prove *who* an agent is, not *what the human asked for*. Mandate evidence has no accepted
  format in representment yet; the vault stores it so merchants are ready when the networks accept it.
- No merchant has yet publicly reported a specific Muse or Dots order being charged back. The pitch is
  "the evidence rules are already broken, here is what to store today," not "agents are already
  committing fraud."

## Layout

```
apps/server    Express + WebSocket server, ZooWork agents, Band bridge, verifier, Stripe staging
apps/exhibit   three.js exhibit (Vite)
packages/seed  dataset generator, evidence vault builder, live event contract, offline replay
reports/       the research report behind the idea (Muse, Dots, merchant complaints, returns, standards)
```
