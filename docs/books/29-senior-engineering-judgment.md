# Book 29 — Senior Engineering Judgment

[Library index](README.md) · Previous: [Book 28](28-architecture-evolution.md) · Next: [Book 30 — AI-Augmented Software Engineering](30-ai-augmented-engineering.md)

**Level:** Senior · **Prerequisites:** the rest of the library.

Technologies are easy to list. Judgment is knowing when **not** to use them. Each chapter asks three questions, grounded in a real Delivery Plus decision:

- **What would a junior usually do?**
- **What would an experienced engineer question?**
- **What would a senior engineer consider before choosing?**

Each chapter ends with a decision guide, a Delivery Plus verdict, and an exercise.

---

## Chapter 1 — When NOT to use microservices

**Junior:** "Microservices are how real companies build systems; one service per noun."
**Experienced:** "How many network hops does checkout take? How do we test a change that touches three services? Who's on call for twelve services?"
**Senior considers:** team size and ownership, deployment independence actually needed, consistency requirements that span boundaries, operational cost per service (health, logs, migrations, config, dashboards), and whether a modular monolith gives the same boundaries without the network.

**Decision guide**
| Signal | Leans to |
| --- | --- |
| One team, one release train, shared database invariants | modular monolith |
| Parts with very different scaling (location ingestion) or ownership | separate service |
| Need independent deploys weekly by different teams | services |

**Delivery Plus verdict:** 12 services in one repo, released together. The boundaries are reasonable (Book 10), but some pairs (delivery + driver availability, restaurant + menu) create cross-service invariants. Tracking-service is the clearest *justified* split (write volume). See [Book 10 Ch. 6](10-microservices-and-domain-design.md#chapter-6--challenging-the-current-boundaries).
**Exercise:** argue for merging two services, then argue against it, each in one paragraph with code references.

---

## Chapter 2 — When NOT to use Kafka

**Junior:** "Events decouple everything; publish everything to Kafka."
**Experienced:** "Who consumes this? Does the caller need the answer now? What happens when the publish fails after the DB commit?"
**Senior considers:** whether there are multiple independent consumers, whether ordering/replay matter, the outbox cost, the operational cost of a broker, and whether a database table + polling or a simple job queue would do.

**Decision guide** — use Kafka for facts with several consumers, replay needs, or high volume; use HTTP for queries and commands that need an answer; use a DB-backed job table for delayed retries and scheduled work at small scale.

**Delivery Plus verdict:** Kafka is justified for lifecycle events (notifications today, dispatch/analytics/tracking tomorrow). Payment → order synchronous sync is kept deliberately (the caller needs the result). Kafka for every driver location point would be the wrong tool (Book 22).
**Exercise:** `order.ready_for_pickup` currently has no consumer. Justify (or reject) using Kafka for automatic dispatch versus delivery-service polling for READY orders.

---

## Chapter 3 — When Redis is unnecessary, and when a query beats a cache

**Junior:** "Cache everything in Redis for speed."
**Experienced:** "What's the hit ratio? What happens when Redis is down? How stale can this be?"
**Senior considers:** whether PostgreSQL with the right index already answers in 1–2 ms; cache invalidation complexity; Redis as a new failure domain (today: cache misses *throw* when Redis is down instead of falling back); memory and eviction policy interacting with correctness data (idempotency markers).

**Decision guide** — cache when reads ≫ writes, data tolerates staleness, and the uncached path is measurably slow; otherwise index and query.

**Delivery Plus verdict:** menu/restaurant caching is reasonable; carts in Redis are defensible (ephemeral, high write rate) but have a lost-update race; idempotency markers in Redis are a pragmatic choice with a known atomicity gap. Rate limiting needs shared state → Redis is right.
**Exercise:** measure `GET /api/menus/restaurants/:id/menu` with and without the cache (`redis-cli DEL menu:<id>` before each request). Is the cache worth its failure mode?

---

## Chapter 4 — When polling is enough, and when WebSockets are justified

**Junior:** "Real-time apps need WebSockets."
**Experienced:** "How often does the data change? How many clients? What happens on reconnect?"
**Senior considers:** change frequency, number of concurrent watchers, infrastructure support for long-lived connections, battery, deploy behaviour, and the fact that correctness must come from snapshots anyway.

**Decision guide** — status changing a few times per order: polling. Location every few seconds with thousands of watchers: push (SSE/WebSocket) with polling fallback.

**Delivery Plus verdict:** polling every 10 s for delivery status is correct today ([ADR 0005](adrs/0005-polling-before-websockets.md)). WebSockets become justified with the driver app streaming locations (Phase 7).
**Exercise:** compute the request rate of polling at 2,000 and 50,000 active deliveries and decide where you'd switch.

---

## Chapter 5 — When denormalization helps, and when to accept eventual consistency

**Junior:** "Normalize everything" — or — "copy everything everywhere for speed."
**Experienced:** "Is this copy a snapshot (frozen on purpose) or a cache (must stay fresh)? Who updates it?"
**Senior considers:** history requirements (prices at purchase time), service independence, the cost of keeping copies fresh, and which inconsistency windows users can tolerate.

**Decision guide** — snapshot what must not change (order lines, delivery address — #95); reference what must stay current (availability); accept eventual consistency where the user can't observe the gap or a short delay is harmless (notifications, delivery status), never where money or exclusivity is at stake (payments, driver assignment).

**Delivery Plus verdict:** order items snapshot correctly; cart prices snapshot too early (#42); driver availability vs assignment is an exclusivity invariant split across services — the place where "eventual" is not acceptable (#33).
**Exercise:** list every copied field in Delivery Plus and label it snapshot or cache.

---

## Chapter 6 — When to prefer correctness over latency (and vice versa)

**Junior:** "Make it fast."
**Experienced:** "What's the cost of being wrong here vs being slow?"
**Senior considers:** money and exclusivity → correctness (CAS, unique indexes, synchronous checks); browsing and notifications → latency and availability.

**Delivery Plus verdict:** the codebase already makes this split: payments use CAS, unique indexes and synchronous order sync; notifications are asynchronous and best-effort. Delivery actions trade latency for correctness by releasing the driver and syncing the order synchronously before responding.
**Exercise:** find one place where Delivery Plus currently favours latency and argue whether that's right.

---

## Chapter 7 — When to optimize, and when to stop

**Junior:** micro-optimises a loop over five cart lines.
**Experienced:** "Where is the time actually spent? Is it the network?"
**Senior considers:** SLOs, measured bottlenecks, the cost of complexity added, and the point where the next 10% isn't worth it.

**Decision guide** — optimise when an SLO is at risk or cost is significant and a measurement points to the bottleneck; stop when the SLO is met with headroom.

**Delivery Plus verdict:** with no production traffic, the right optimisations are cheap structural ones (indexes on hot filters, keyset pagination for unbounded lists), not caches or new infrastructure.
**Exercise:** pick one row of [Book 21 Ch. 6](21-performance-engineering.md#chapter-6--applying-it-the-hot-paths-of-delivery-plus), measure, and decide *not* to optimise it — with evidence.

---

## Chapter 8 — Build vs buy, simplicity vs flexibility

**Junior:** "We can build it ourselves" (routing engine, WebSocket infrastructure, auth server, payment processing).
**Experienced:** "What's the maintenance cost after it's built?"
**Senior considers:** core vs context (what differentiates the business), total cost of ownership, vendor lock-in, compliance (PCI), and team skills.

**Delivery Plus verdict:** build: dispatch logic (core business), domain services. Buy/adopt: payments (a gateway, never card handling), routing/ETA (an API or OSRM), push delivery (Expo/FCM/APNs), managed databases and Kafka in production, maybe real-time infrastructure. The project already made one such call: SeaweedFS instead of MinIO when MinIO images became gated.
**Exercise:** write a one-page build-vs-buy analysis for routing/ETA.

---

## Chapter 9 — Reliability vs velocity, operational burden, cost and technical risk

**Junior:** "Ship features; we'll harden later." — or — "We can't ship until everything is perfect."
**Experienced:** "Which failures would hurt customers or money? Which can we detect and fix quickly?"
**Senior considers:** error budgets, blast radius, reversibility of decisions (one-way vs two-way doors), the cost of every new component (on-call, upgrades, security patches), and cloud cost.

**Decision guide** — one-way doors (data models, public APIs, money flows) deserve care; two-way doors (internal implementations behind interfaces) deserve speed.

**Delivery Plus verdict:** the hardening and Kafka-reliability phases were spent on one-way doors (money, events, authorization). Kubernetes, multi-region and WebSockets are deferred — correctly — until they solve a measured problem.
**Exercise:** classify the next sprint's issues (#33, #95, #96, #97) as one-way or two-way doors.

---

## Chapter 10 — Migration strategy, designing for failure, communicating trade-offs

**Junior:** proposes a rewrite.
**Experienced:** proposes an incremental path with rollback.
**Senior considers:** sequencing that keeps the system shippable at every step, explicit failure behaviour for every arrow in the design, and communicating options with costs to non-engineers.

**Communicating a trade-off — template**
```text
Decision needed: <one line>
Options: A / B / C — each with: what it costs, what it risks, what it unlocks
Recommendation: <one option>, because <evidence>
What would change my mind: <signal>
Reversibility: <one-way / two-way door>
```

**Delivery Plus example:** "Should checkout fail when Kafka is down?" — A: fail (consistent, less available), B: accept and lose events (available, inconsistent — today's behaviour), C: outbox (available and consistent, costs a table and a relay). Recommendation: C, because B silently loses notifications and future dispatch triggers.
**Exercise:** write this template for "move driver availability ownership to delivery-service" and present it to someone non-technical.

---

[Library index](README.md) · Previous: [Book 28](28-architecture-evolution.md) · Next: [Book 30 — AI-Augmented Software Engineering](30-ai-augmented-engineering.md)
