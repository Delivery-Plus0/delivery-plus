# Book 28 — Software Architecture & Evolution

[Library index](README.md) · Previous: [Book 27](27-advanced-data-patterns.md) · Next: [Book 29 — Senior Engineering Judgment](29-senior-engineering-judgment.md)

**Level:** Senior · **Prerequisites:** [Book 10](10-microservices-and-domain-design.md), [Book 18](18-cicd-and-devops.md), [Book 27](27-advanced-data-patterns.md).

Architecture is not a diagram drawn once; it is a set of decisions that must keep holding while the code changes every day. This book uses Delivery Plus's own history — fixes, migrations, drift and records — to teach how architecture is protected and evolved.

---

## Chapter 1 — Architecture decisions and ADRs

### 1. Why this exists
Six months later nobody remembers *why* the system is shaped this way, so good decisions get undone and bad ones get copied.

### 2. Core concept — an **Architecture Decision Record**: context, decision, alternatives, consequences, status (proposed/accepted/superseded). Short, immutable once accepted, superseded rather than edited.
### 3. Mental model — ADRs are commit messages for architecture.
### 4. Delivery Plus mapping — **CURRENT**: `docs/adr/001-internal-service-authentication.md` (HMAC-signed internal requests), with `docs/adr/adr-template.md` and `docs/adr/README.md`. The library's [adrs/](adrs/README.md) folder adds teaching ADRs reconstructed from the code (clearly marked as such) and one proposed ADR (outbox).
### 5. Example — [ADR 0004 — orderId as Kafka partition key](adrs/0004-orderid-partition-key.md): context (random keys hid an ordering bug behind single-partition topics), decision, consequences (per-order ordering; partition count changes remap keys).
### 6. Failure scenario — decisions living only in chat threads: a new engineer "simplifies" the CAS update back to a plain update and duplicate notifications return.
### 7. Trade-offs — ADRs cost minutes; their absence costs re-litigation.
### 8–10. n/a / see chapters below.

### 11. Lab — write an ADR for "driver availability is changed only by delivery-service" (the decision behind removing driver-service's Kafka consumer).
### 12. Verification — your ADR names the rejected alternative (event-driven release) and why.

### 13. Interview questions
- *Senior:* What belongs in an ADR and what doesn't?
- *Senior:* How do you find out which decisions were never recorded?

### 14. Senior discussion
Should ADRs live next to code (`docs/adr/`) or in a wiki? What keeps them discoverable?

---

## Chapter 2 — Fitness functions: protecting architecture automatically

### 1. Why this exists
Rules that aren't checked erode.

### 2. Core concept — an **architecture fitness function** is an automated check that a property still holds: contract stability, migration validity, dependency direction, performance budget, security baseline.
### 3. Mental model — tests for architecture.
### 4. Delivery Plus mapping — **CURRENT** fitness functions in CI:
| Property | Check |
| --- | --- |
| Public API contract is intentional | OpenAPI regenerated and diffed (`pr-quality.yml`) |
| Internal routes never public | `isBlockedInternalRoute` tests; `public-openapi.ts` asserts no `/internal` path |
| Schema is reproducible | `migration-verification.yml` (fresh DBs, no pending migrations, legacy upgrade) |
| Critical business path works | `integration.yml` (`npm run e2e`) |
| No critical vulnerabilities | Trivy, CodeQL, npm audit |
**Missing (FUTURE):** dependency-direction rules (services must not import each other — only `shared`), event-contract compatibility checks (#23), performance budgets.
### 5. Example — a dependency rule (FUTURE) with `dependency-cruiser`: forbid `services/order-service/**` from importing `services/payment-service/**`.
### 6. Failure scenario — someone imports a type from another service's folder "just this once"; the services now deploy together forever.
### 7. Trade-offs — too many fitness functions slow CI and create noise.
### 8. Performance — budgets can be fitness functions (p95 in a benchmark job).
### 9. Security — secret scanning is a fitness function.
### 10. Operations — fitness functions in production: SLO dashboards.

### 11. Lab — add (locally) a check that fails if any `services/*` file imports from another `services/*` folder; run it.
### 12. Verification — it passes today (verify with `grep -rn "from '../../../" services/*/src | grep services/`).

### 13. Interview questions
- *Senior:* Give three fitness functions for an event-driven system.

### 14. Senior discussion
Which architectural property of Delivery Plus is most at risk of silent erosion, and how would you guard it?

---

## Chapter 3 — Coupling, cohesion, dependency direction and drift

### 1. Why this exists
Over time, code drifts from the intended architecture, and documentation drifts from the code.

### 2. Core concept — afferent/efferent coupling, stable dependencies principle (depend on things more stable than you), **architecture drift** (code violates intent), **documentation drift** (docs describe a past system).
### 3. Mental model — `shared/` is the most depended-upon component: it must be the most stable and the most carefully changed.
### 4. Delivery Plus mapping
- Dependency direction — **CURRENT:** services → `shared`; services never import each other (they talk over HTTP/Kafka).
- Documentation drift — **real example:** after the Kafka reliability work, `README.md` and `docs/architecture.md` still said delivery events were "not published yet" and showed driver-service consuming Kafka; the diagrams were corrected along with a Mermaid syntax fix. `.project-context/16-current-state.md` is maintained as the "what is true now" document.
- `shared/` stability risk — issue #30 (export contract), #101 (coordinated dependency upgrades).
### 5. Example — the stale diagram was detected only because GitHub failed to render it — the content drift had gone unnoticed.
### 6. Failure scenario — onboarding from stale docs: a new engineer builds on a consumer that no longer exists.
### 7. Trade-offs — generated docs (OpenAPI) never drift; prose docs always do.
### 8–10. n/a.

### 11. Lab — pick one `.project-context` file and verify five claims against the code; open a docs PR for any drift.
### 12. Verification — each claim has a file reference.

### 13. Interview questions
- *Senior:* How do you keep architecture documentation true?

### 14. Senior discussion
Should parts of `.project-context/` be generated from code (topics, routes, consumers) to prevent drift?

---

## Chapter 4 — Evolutionary architecture: strangler, expand/contract, parallel run

### 1. Why this exists
Large changes must be made in small, reversible, deployable steps while the system runs.

### 2. Core concept
- **Strangler fig**: build the new path alongside the old, route gradually, remove the old.
- **Expand/contract** (also for APIs and events): add new, migrate consumers, remove old.
- **Parallel run / dark launch**: run the new path, compare results, don't act on them yet.
- **Feature flags**: switch behaviour without deploys.

### 3. Mental model — never a big bang; always a bridge.
### 4. Delivery Plus mapping — real and planned migrations:
| Change | Pattern |
| --- | --- |
| Order status sync: HTTP-only → HTTP + events (CAS makes the second path a no-op) | parallel paths — **CURRENT** |
| Manual dispatch → automatic dispatch (#97), manual endpoints kept | strangler — **CURRENT** |
| Direct publish → outbox (#98) | switch one event type at a time behind a flag: write it to the outbox instead of publishing directly, let the relay publish it — **PLANNED** |
| Polling → WebSocket tracking, polling kept as fallback | strangler — **FUTURE** |
| Simulated payments → real gateway via adapter | strangler behind the provider port — **FUTURE** |
| Event payloads gain `customerId` (#5) | expand (optional field) → consumers use it → never remove | **PLANNED** |
### 5. Example — automatic dispatch rollout: (1) consumer deployed in *dry-run* mode logging the driver it would pick; (2) compare with manual picks; (3) enable for one restaurant; (4) enable for all; (5) manual endpoints become admin-only overrides.
### 6. Failure scenario — big-bang switch from polling to WebSockets: an untested reconnect bug leaves every customer without updates.
### 7. Trade-offs — bridges cost temporary duplication and flags; big bangs cost outages.
### 8. Performance — parallel runs double some work temporarily.
### 9. Security — flags must not bypass authorization.
### 10. Operations — remove flags and old paths on a schedule (flag debt).

### 11. Lab — write the rollout plan for the outbox in order-service with verification gates.
### 12. Verification — each step is reversible and observable.

### 13. Interview questions
- *Senior:* Explain the strangler fig pattern with a Delivery Plus example.
- *Senior:* How do you roll back a half-finished migration?

### 14. Senior discussion
What is the safest order to introduce auto-dispatch, the driver current-delivery endpoint and the driver app?

---

## Chapter 5 — Backward compatibility and versioning

### 1. Why this exists
Mobile apps can't be force-updated instantly; consumers of events and APIs upgrade at their own pace.

### 2. Core concept — additive changes are safe; removals/renames/semantic changes need versioning (URL, header, field) and deprecation windows; event schemas follow the same rules; databases follow expand/contract.
### 3. Mental model — every published interface has unknown dependants.
### 4. Delivery Plus mapping — **CURRENT:** no API versioning (`/api/...`); OpenAPI committed; events additive by convention. Behaviour change worth noting: repeated delivery actions now return success instead of 409 — compatible for clients, but a behaviour change documented in the PR.
### 5. Example — deprecating `PaginatedResult.total` (FUTURE): keep returning it, add `nextCursor`, update clients, then make `total` optional with a sunset date.
### 6. Failure scenario — the customer app version in stores expects a field the backend removed; old app versions crash on launch.
### 7. Trade-offs — versioned APIs multiply maintenance; unversioned APIs require discipline.
### 8–10. n/a.

### 11. Lab — classify five recent changes in `docs/openapi/delivery-plus-public.json` history (git log) as additive or breaking.
### 12. Verification — every breaking change has a migration note in its PR.

### 13. Interview questions
- *Senior:* API versioning strategy for three mobile/web clients.

### 14. Senior discussion
Would you introduce `/api/v1` now, before the driver app ships, or wait until the first breaking change?

---

## Chapter 6 — Technical debt and incremental modernisation

### 1. Why this exists
Every system accumulates shortcuts; the question is which to repay and when.
### 2. Core concept — classify debt (deliberate/inadvertent, prudent/reckless), estimate interest (how often it hurts), pay down where interest is highest, attach debt to roadmap work.
### 3. Mental model — debt with high interest and low principal first.
### 4. Delivery Plus mapping — the GitHub milestones are a debt register: Phase 1 hardening rest (#18, #19, #42, #53, #56, #59), Phase 2 outbox (#98), Phase 9 production readiness (#6, #7, #8, #14, #15, #16, #30, #37, #38, #101).
### 5. Example — interest estimate: missing internal timeouts (#6) costs nothing until a dependency hangs — then it costs an outage. Low daily interest, catastrophic tail.
### 6. Failure scenario — "we'll fix it before launch" without a date; launch arrives with the debt.
### 7. Trade-offs — feature velocity vs risk; a fixed percentage of capacity for debt is a common compromise.
### 8–10. n/a.

### 11. Lab — rank the Phase 9 issues by (likelihood × impact) / effort.
### 12. Verification — your top three are defensible with evidence from this library.

### 13. Interview questions
- *Senior:* How do you convince a product manager to prioritise debt?

### 14. Senior discussion
Which Delivery Plus debt item would you refuse to launch without, and which would you knowingly carry?

---

[Library index](README.md) · Previous: [Book 27](27-advanced-data-patterns.md) · Next: [Book 29 — Senior Engineering Judgment](29-senior-engineering-judgment.md)
