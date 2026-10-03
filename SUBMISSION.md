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
- A real Web Bot Auth verifier (RFC 9421, Ed25519, key directory, nonce store) with signed,
  tampered, replayed, Muse-like and human test clients.
- A five-agent war room on ZooWork Managed Agents with custom tools over the vault, coordinated
  through Band @mentions, with tiered verdicts and deterministic fallbacks.
- A VAMP-aware dispute router that creates real Stripe test-mode disputes and stages evidence
  unsubmitted for human approval.
- A three.js exhibit with the live evidence graph, agent transcript, verdict, routing and the staged
  package with a deadline countdown.
- A 236-order synthetic merchant with planted abuse patterns: double dip, empty box, bracketing,
  AI-generated damage photos, a five-account ring, a serial returner, and a loyal customer with a
  genuine defect.

**Track / P&L line:** Risk, lose less. Returns abuse, refund fraud and chargebacks.

**Sponsor tools:** ZooWork (agents and tools), Band (room coordination between five registered
agents), Entire (every Claude Code session attached to the commits, 8 checkpoints), Stripe test mode.

**Links:**
- Repo: https://github.com/zMako/receipts
- Demo: live on the laptop at the exhibit station (localhost), plus the Stripe test dashboard and
  the Band room
- Research report behind the idea: reports/Muse Dots merchant pain points.md in the repo

**Team:** Maciej Kopiec (Assistron), built with Claude Code.
