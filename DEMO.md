# Receipts demo script (about 3 minutes)

Before judges arrive: server (`npm run dev`) and exhibit (`npm run exhibit`) running, Stripe test
dashboard open in a second tab at https://dashboard.stripe.com/test/disputes, the Band room
"Dispute War Room" open in a third tab. Exhibit on the big screen at http://localhost:5173.
Press **Esc** to reset to a clean state.

## 0:00 Hook (20 s)

"Three weeks ago the shopper got an agent. Meta Muse hit number one on the App Store, Amazon blocked
it, OpenAI shipped Dots. Those agents arrive at checkout as plain Chromium: no signature, no agent
header, no customer device, no residential IP. That's exactly the evidence a merchant needs to win
a chargeback. Shopify switched agent checkout on for every US store by default. The merchant's only
lever is refunding before the chargeback is filed, and today that's a guess."

## 0:20 The graph (20 s)

Point at the exhibit. "This is a real-shaped merchant: 236 orders, 75 customers. Blue orders are
humans. Orange are undeclared agents, Muse-like sessions. Green are signed agents. That big magenta
node is one device: the Muse sandbox image, shared by 37 orders from different customers. The
merchant cannot tell them apart from a bot farm, and neither can Visa."

## 0:40 Checkout verifier (30 s)

In a terminal: `cd apps/server && npx tsx scripts/agents/all.ts`

"Three shoppers hit the same checkout. A signed agent: Ed25519 signature over the request, key
resolved from its well-known directory, nonce checked, Visa Trusted Agent token. Verified. The same
agent with a tampered signature, rejected. A replayed request, rejected. A Muse-like browser:
no signature, sandbox fingerprint, Cloudflare egress, zero hover events, undeclared-suspected.
And a human. The vault stores different evidence for each, in the shape Stripe's Compelling
Evidence 3.0 fields expect."

## 1:10 The war room, live (75 s)

Press **L** (Run live). Point at the Band room tab briefly.

"A chargeback just came in on a Muse order: 'I did not make this purchase, an AI assistant placed
it.' The Critic opens a room on Band and mentions four specialists. Each is a ZooWork managed
agent with its own tools over the vault. Watch them fly to the case."

As evidence streaks in, narrate the ones that appear:
- Identity: "shared sandbox fingerprint, cloud egress, single-use card. Undeclared agent. No
  device evidence exists, CE 3.0 is off the table."
- Logistics: "delivered with proof to the right address. And here's the thing: a return on this
  order was already refunded in full three minutes after the carrier's first scan. The parcel
  weighed what a parka weighs. The item came back."
- Forensics: "the 'my agent did it' statement. Under Meta's own terms the user is responsible
  for their agent's purchases. And the return was filed through the same agent."
- Critic: "Verdict: decline. Double recovery. Routing: represent, not refund-and-close, because
  refunding would pay twice. VAMP ratio 1.33 percent, six items from Visa's threshold."

Switch to the Stripe tab, refresh: "The evidence package is already staged in Stripe, unsubmitted.
Fourteen fields: prior refund, delivery scan, policy snapshot, session telemetry, agent population.
A human clicks submit. Due in five days, the countdown is on screen."

## 2:25 Contrast (25 s)

"Same system, opposite answer." Open `ret_loyal_defect` (POST /api/cases/open with the return id, or
mention the result): "A 640-day VIP with a genuine seam failure and real photos: exchange first,
instant. And a signed-agent order disputed as fraud: the passkey-authenticated token proves the
cardholder authorised it, so we represent with the token as evidence. Receipts is not a bot
blocker. It is a scored decision on every claim, with the receipts attached."

## 2:50 Close (10 s)

"Built today on ZooWork managed agents, coordinated through Band, tracked by Entire, with real
Stripe test disputes. The evidence rules are already broken. This is what a merchant stores
starting Monday."

## If something stalls

- Agents slow: the case finishes on its own after 170 s with deterministic fallback evidence.
- Band down: the server runs the specialists in-process and says so in the log.
- Stripe down: the package is staged locally and shown in the panel.
- Exhibit frozen: press **R** for the offline replay of the same case.
