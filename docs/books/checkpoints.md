# Checkpoints

[Library index](README.md) · Previous: [Book 30](30-ai-augmented-engineering.md)

A checkpoint is how you know you have finished a level. Each item is something you **do** or **explain without notes**, using Delivery Plus. Do them in writing, keep the answers in a notebook or a branch, and revisit them after a month.

- **Pass a level** when you can do every item and explain your answer to someone else in about five minutes.
- **If an item takes you more than an hour,** go back to the books listed next to it.

The levels match [Book 00 §3](00-how-to-use-this-curriculum.md#3-levels).

---

## Junior checkpoint

*Solid fundamentals: you can work on one service safely.*

### Run and read

- [ ] Start the dev stack, run `npm run seed`, sign in as `customer@example.com`, and place an order with `curl` alone ([lab environment](labs/README.md#lab-environment)). — Books 03, 14
- [ ] Follow `POST /api/orders` from the gateway to the database row, naming every file on the way ([code-reading guide](code-reading-guide.md#order-creation)). — Books 01, 11
- [ ] Explain what `JwtAuthGuard`, `RolesGuard` and `@CurrentUser()` each do, and where the user ID in a request comes from. — Books 11, 17

### Data

- [ ] Write SQL for "each customer's order count and total spend, including customers with no orders" on `order_service` and `user_service`. Explain why this needs two queries here ([DB-02](labs/database-labs.md#db-02-joins-aggregates-and-nulls-on-real-orders)). — Books 04, 10
- [ ] Show with `EXPLAIN ANALYZE` a query that uses an index and one that doesn't, and explain the difference ([DB-03](labs/database-labs.md#db-03-index-vs-sequential-scan)). — Book 05
- [ ] List every Redis key pattern in the system, its owner and its TTL ([RD-01](labs/redis-labs.md#rd-01-tour-the-keyspace)). — Book 06

### HTTP and tests

- [ ] Produce 400, 401, 403, 404, 409 and 429 on purpose, and say which ones a client should retry ([SEC-01](labs/security-labs.md#sec-01-status-code-tour)). — Book 03
- [ ] Write a unit test for a service method with a mocked repository, plus one test that would fail if an ownership check were removed. — Book 12
- [ ] Explain why a JWT can be read by anyone but not forged ([SEC-02](labs/security-labs.md#sec-02-inspect-and-tamper-with-a-jwt)). — Book 17

### Tools

- [ ] Find a container's logs, exec into it, and read its environment ([OPS-01](labs/devops-labs.md#ops-01-look-inside-a-container)). — Books 14, 15

---

## Intermediate checkpoint

*Service ownership and debugging: you can own a service and debug across services.*

- [ ] Explain the checkout sequence: order → payment create → process → order sync and events. For each step, what happens if it fails or is retried ([DS-02](labs/distributed-systems-labs.md#ds-02-double-submit-checkout), [DS-03](labs/distributed-systems-labs.md#ds-03-retry-payment-processing-after-a-failure)). — Books 08, 09
- [ ] Show a lost update and the compare-and-set fix in two `psql` sessions ([DB-05](labs/database-labs.md#db-05-lost-update-vs-compare-and-set)). Then find the CAS writes in order-service and delivery-service. — Books 04, 08
- [ ] Produce and consume a Kafka event by hand. Explain partitions, keys, consumer groups and offsets with the real topics ([KF-01](labs/kafka-labs.md#kf-01-produce-and-consume-by-hand) – [KF-05](labs/kafka-labs.md#kf-05-offsets-and-commits)). — Book 07
- [ ] Restart a consumer mid-stream and prove redelivered events are skipped ([KF-07](labs/kafka-labs.md#kf-07-redelivery-after-restart-is-skipped)). Explain why the old in-memory set wasn't enough ([case study 06](case-studies/06-in-memory-idempotency.md)). — Books 07, 08
- [ ] Break a handler, watch its message reach the DLQ, fix it and replay ([KF-10](labs/kafka-labs.md#kf-10-handler-failure-dlq-and-replay)). — Books 07, 26
- [ ] Reproduce a BOLA check across five resources and explain 403 versus 404 ([SEC-07](labs/security-labs.md#sec-07-reproduce-a-bola-check)). — Book 17
- [ ] Explain a fixed-window rate limiter and its two known flaws here ([RD-04](labs/redis-labs.md#rd-04-fixed-window-rate-limiter), [case study 05](case-studies/05-rate-limit-mismatch.md)). — Books 06, 17
- [ ] Run the customer app's smoke suite against the E2E stack, then break one assertion and read the failure artefacts ([E2E-02](labs/e2e-labs.md#e2e-02-customer-login-and-checkout), [E2E-03](labs/e2e-labs.md#e2e-03-failure-screenshot-and-offline-recovery)). — Book 13
- [ ] Read every GitHub Actions workflow and say what each one blocks a merge for. — Book 18
- [ ] Back up and restore one service database ([OPS-07](labs/devops-labs.md#ops-07-backup-and-restore-one-service-database)). — Books 05, 18

---

## Advanced checkpoint

*Distributed systems and production trade-offs.*

- [ ] Explain why a timeout doesn't tell you whether the operation happened, and how the system copes for orders, payments and deliveries ([DS-01](labs/distributed-systems-labs.md#ds-01-timeout-ambiguity)). — Book 09
- [ ] Take Kafka down during checkout and describe exactly what is lost and what recovers ([OPS-04](labs/devops-labs.md#ops-04-kafka-outage-during-checkout)). Then design the outbox that would fix it ([DS-11](labs/distributed-systems-labs.md#ds-11-outbox-simulation), [ADR 0010](adrs/0010-transactional-outbox.md)). — Books 08, 27
- [ ] Complete a delivery with order-service down and show the retry converges ([DS-06](labs/distributed-systems-labs.md#ds-06-repeat-delivery-completion-with-a-service-down)). Explain why driver-service no longer consumes delivery events ([case study 08](case-studies/08-delivery-lifecycle-events.md)). — Books 09, 10
- [ ] Measure consumer lag, and propose metrics, alerts and an SLO for "payment reflected on the order" ([KF-06](labs/kafka-labs.md#kf-06-consumer-lag), [case study 17](case-studies/17-consumer-lag.md)). — Books 07, 20
- [ ] Load-test the restaurant list. Report p50, p95 and p99, find the bottleneck and show one improvement ([OPS-05](labs/devops-labs.md#ops-05-load-test-the-restaurant-list)). — Book 21
- [ ] Compute the polling cost for 10,000 active orders and design the WebSocket alternative, including reconnect and fallback ([case studies 11](case-studies/11-customer-delivery-polling.md) and [12](case-studies/12-future-websocket-tracking.md)). — Book 22
- [ ] Implement nearest-K drivers three ways and compare them ([GEO-05](labs/geo-and-algorithms-labs.md#geo-05-nearest-k-drivers), [RD-06](labs/redis-labs.md#rd-06-redis-geo-nearest-drivers)). — Books 02, 23
- [ ] Explain the payment side-effect markers and lease, the owner-token gap (#19), and what a real provider adds (webhooks, reconciliation). — Book 25
- [ ] Write the Kubernetes manifests one service would need (probes, resources, config, secrets) and say which current behaviour would break (no graceful shutdown, #7). — Books 19, 26
- [ ] Assess the [system token](case-studies/18-system-token.md) and the [self-registered admin](case-studies/21-self-registered-admin.md) flaw: impact, the fix, and how to verify the fix. — Book 17

---

## Senior checkpoint

*Architecture and judgement.*

- [ ] **Design review.** Draw the current architecture from the code alone. Mark every synchronous call, every event and every store. Circle the three riskiest couplings and justify each. — Books 24, 28
- [ ] **Scale estimate.** For 10× today's design target (pick numbers and state them): requests per second at the gateway, Kafka throughput, PostgreSQL write rate per service, Redis memory. Name what breaks first. — Books 21, 24
- [ ] **Decision.** Argue for *and* against one teaching ADR ([ADRs](adrs/README.md)), then state what evidence would change your mind. — Book 29
- [ ] **Migration plan.** Plan the outbox rollout (#98) with flags, a dual-publish phase, verification, rollback and success metrics. — Books 27, 28
- [ ] **Incident review.** Write a blameless postmortem for "payment-completed events dead-lettered for 20 minutes" ([case study 16](case-studies/16-kafka-replay.md)): timeline, detection gap, contributing factors, action items with owners. — Books 20, 26
- [ ] **Roadmap.** Order the open issues #33, #95, #96, #97, #98 and #99 by risk and value, explain the dependencies, and say what you would *not* build. — Books 28, 29
- [ ] **Security posture.** Write a one-page threat model for the platform with the top five risks and their mitigations (current and missing). — Book 17
- [ ] **Review an AI-written change.** Take a change produced with an AI assistant, verify every claim it makes against the code, and list what you rejected and why. — Book 30
- [ ] **Teach it.** Explain idempotency, ordering and ownership in Delivery Plus to a junior engineer in 15 minutes, with the code open.

---

[Library index](README.md) · [Code-reading guide](code-reading-guide.md)
