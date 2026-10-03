# Submission text (paste into the form)

**Project name:** Receipts

**Tagline:** The evidence vault and dispute war room for merchants in the age of shopping agents.

**One-liner:** Receipts classifies every order by who really placed it (human, signed agent, or an
undeclared Muse-style agent), stores the evidence Visa and Stripe actually accept, and when a return
or chargeback arrives, five ZooWork agents coordinate in a Band room to score the claim, route the
dispute for the lowest VAMP exposure, and stage the Stripe evidence package for one-click approval.

**The problem:** Meta Muse and OpenAI Dots arrive at checkout as plain Chromium: no signature, no
agent header, no customer device or IP. That erases the evidence merchants need under Visa Compelling
Evidence 3.0, while Shopify switched agent checkout on by default and half of consumers already draft
return claims with GenAI. Returns run at 15.8 percent of sales, 9 percent of them fraudulent; net
chargeback recovery is 10.7 percent. The merchant's only lever is refunding before the chargeback is
filed, and today that is a guess.

**What we built (today):**
- A population classifier and per-order evidence vault with CE 3.0 records for humans and identity
  records (Web Bot Auth, Visa Trusted Agent Protocol, shared payment tokens, mandates) for agents.
- A real Web Bot Auth verifier (RFC 9421, Ed25519, key directory, nonce store, content-digest
  binding so a payment signature names the cart) with signed, unbound, swapped-cart, tampered,
  replayed, Muse-like and human test clients.
- A five-agent war room on ZooWork Managed Agents with custom tools over the vault, coordinated
  through Band @mentions, with tiered verdicts and deterministic fallbacks.
- A VAMP-aware dispute router that creates real Stripe test-mode disputes, stages the evidence
  unsubmitted, and submits it on the merchant's one-click approval.
- An inbox-first exhibit: a queue of open chargebacks and claims, a four-step progress bar, a
  per-agent outline of findings, a node inspector for merchant-level facts, and a three.js map of
  the merchant (customers on a spiral with their orders, the Muse and Dots sandbox hubs at the
  centre, shared devices and addresses between linked accounts) that spotlights each case as the
  evidence lands.
- A 236-order synthetic merchant with planted abuse patterns: double dip, empty box, bracketing,
  AI-generated damage photos, a five-account ring, a serial returner, and a loyal customer with a
  genuine defect.

**Track / P&L line:** Risk, lose less. Returns abuse, refund fraud and chargebacks.

**How the sponsors are used (where, not just that):**
- **ZooWork Managed Agents** run the whole investigation: five agents (history, logistics, identity,
  forensics, critic), each created through the SDK with application-executed custom tools over the
  evidence vault (customer history, return tracing, session classification, linked accounts, claim
  forensics, verdict, routing). Deterministic fallbacks keep a live demo moving if a turn stalls.
- **Band** is the coordination layer, not a log: the critic posts the case brief into the "Dispute War
  Room" and @mentions the four specialists; each specialist is a registered Band agent that wakes on
  its mention, investigates, and replies to the critic through the room. The exhibit shows "via Band"
  on each agent as it wakes. Remove Band and the coordination breaks.
- **Entire** mirrors the repo and attached every Claude Code session of this build to its commits
  (twenty-plus checkpoints), so a judge can audit how the code was made, not just read it.
- Stripe (not a sponsor) is the payments rail, in test mode: disputes are created, evidence staged
  with `submit=false`, and submitted on the merchant's approval click.

**Links:**
- Repo: https://github.com/zMako/receipts
- Video: <paste the unlisted link>
- Live demo: https://zmako.github.io/receipts/ (forwards to the exhibit running on the team's
  laptop), with the Stripe test dashboard and the Band room open beside it at the station
- Research report behind the idea: reports/Muse Dots merchant pain points.md in the repo

**Team:** Maciej Kopiec (Assistron), built with Claude Code.
