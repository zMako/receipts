# Submission form fields (plain text, paste as is)

## Project name

Receipts

## Tagline / summary (single field)

Shoppers have AI agents now, merchants don't. Receipts screens every return and chargeback: it knows whether a human or an agent placed the order, keeps the evidence that wins disputes, and puts five coordinated agents on every claim.

## Description

Shopping agents like Meta Muse and OpenAI Dots check out as plain Chromium browsers: no signature, no customer device, no residential IP. That is exactly the evidence a merchant needs to win a chargeback under Visa's Compelling Evidence 3.0 rules, and Shopify switched agent checkout on for every US store by default. Returns already run at 15.8 percent of online sales, 9 percent of them fraudulent, and net chargeback recovery sits at 10.7 percent. The merchant's only real lever is refunding before the chargeback is filed, and today that decision is a guess.

Receipts is the merchant's answer. At checkout it verifies signed shopping agents (Web Bot Auth over RFC 9421, Ed25519, key directory, nonce store, content-digest binding so the signature names the cart), classifies the rest as human, declared or undeclared agent from fingerprint and session signals, and stores the right evidence for each order: CE 3.0 records for humans, identity tokens and mandates for agents, delivery proof and the policy snapshot for everyone.

When a return claim or a chargeback arrives, it becomes a case. Five agents run on ZooWork Managed Agents, each with custom tools over the evidence vault: History reads the customer record, Logistics traces delivery and the return parcel, Identity classifies the session and finds linked accounts, Forensics inspects claim text and photos, and the Critic weighs everything into a tiered verdict: instant refund, exchange first, refund on inspection, require verification, or decline. They coordinate through a Band room: the Critic posts the brief and mentions the specialists, and their replies route back through the room. For chargebacks, a router chooses refund-and-close or representment by Visa VAMP exposure, creates the dispute in Stripe test mode, stages the evidence package, and submits it when the merchant clicks approve.

The exhibit is an inbox: a queue of open chargebacks and claims, a four-step progress bar, each agent's findings as they land, and a map of the merchant showing every customer and order, the Muse and Dots sandbox hubs at the centre, and the shared devices and addresses that link abusive accounts. Pick a case and watch it get decided in under a minute.

Built today on ZooWork, coordinated through Band, with every Claude Code session of the build captured by Entire. The merchant data is synthetic with planted abuse patterns; the agents, the coordination, the verifier and the Stripe round trip are real.

## Links

Repo: https://github.com/zMako/receipts
Video: <paste the unlisted link>
Live demo: https://zmako.github.io/receipts/ (forwards to the exhibit running on the team's laptop)

## Sponsor tracks

ZooWork, Band, Entire

## Team

Maciej Kopiec (Assistron)
