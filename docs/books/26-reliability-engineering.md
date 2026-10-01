# Book 26 — Reliability Engineering

[Library index](README.md) · Previous: [Book 25](25-payment-systems.md) · Next: [Book 27 — Advanced Data Patterns](27-advanced-data-patterns.md)

**Level:** Advanced → Senior · **Prerequisites:** [Book 09](09-distributed-systems.md), [Book 20](20-observability.md).

Reliability is the probability the system does what users need, when they need it. This book defines the vocabulary, maps every Delivery Plus dependency's failure behaviour **as it is today**, and turns that map into playbooks you can rehearse locally.

---

## Chapter 1 — Measuring reliability

### 1. Why this exists
"Make it more reliable" is not actionable; "reduce checkout failures from 2% to 0.5%" is.

### 2. Core concept
- **Availability** = good time / total time (or good requests / total).
- **MTTF** (mean time to failure), **MTTR** (mean time to recovery). Availability ≈ MTTF / (MTTF + MTTR). Cutting MTTR is usually cheaper than raising MTTF.
- **Redundancy**: N+1 copies so one failure doesn't stop service.
- **SLOs and error budgets** (Book 20 Ch. 4).

### 3. Mental model — you can't prevent all failures; you can shorten them and shrink their blast radius.

### 4. Delivery Plus mapping — every stateful component is a single instance today (PostgreSQL, Redis, Kafka, ZooKeeper, SeaweedFS); each is a single point of failure for the features that use it. Services are single instances too, but stateless — restartable in seconds.
### 5. Example — if PostgreSQL fails monthly and takes 2 hours to restore manually, availability ≈ 99.7%; automated failover in 1 minute → ≈ 99.998%.
### 6. Failure scenario — investing in multi-region before having backups: high complexity, and the most likely data-loss event (a bad migration) is still unrecoverable.
### 7. Trade-offs — every nine costs roughly 10× more.
### 8. Performance — redundancy can add latency (synchronous replication).
### 9. Security — availability is part of security (DoS).
### 10. Operations — measure incidents: count, duration, detection time, recovery time.

### 11. Lab — fill in the failure-mode table of Chapter 2 yourself from the code before reading it.
### 12. Verification — your table matches, or you found something the book missed (open an issue).

### 13. Interview questions
- *Beginner:* What is MTTR?
- *Intermediate:* Why is lowering MTTR often better than raising MTTF?
- *Advanced:* Where are the single points of failure in Delivery Plus?
- *Senior:* Reliability roadmap for launch with a three-person team.

### 14. Senior discussion
Which single reliability investment buys the most for Delivery Plus today?

---

## Chapter 2 — Failure-mode analysis of Delivery Plus (as built)

| Dependency down | What breaks | What still works | Data at risk | Recovery |
| --- | --- | --- | --- | --- |
| **PostgreSQL** | every write and most reads in 9 services; `/health/ready` reflects it where implemented | gateway `/health`, cart (Redis), tracking writes (Redis) | none if the volume survives; everything if it doesn't (no backups, #16) | restart; restore from backup (none) |
| **Redis** | carts; every rate-limited route (guard throws → fail closed); Kafka consumers in order/notification (claims fail → no commit, redelivered later); user registration (nonce check); tracking; restaurant and menu reads (the cache does not fall back to PostgreSQL — `getOrSet` throws) | order/payment/delivery reads that don't touch Redis | last ≤ 1 s of writes (AOF everysec) | restart; AOF replay |
| **Kafka** | producers throw *after* DB commit → requests 500 (or idempotent replay) and **events lost** (no outbox); consumers pause | all synchronous HTTP flows (payment → order sync, delivery syncs) | events produced during the outage | restart; outbox (#98) to prevent loss |
| **order-service** | checkout, order reads, payment's order sync (payment keeps owed effects and retries on next request), delivery syncs (retry-safe) | browsing, cart, driver/delivery reads | none (owed effects are tracked) | restart; client retries |
| **driver-service** | assign, every driver-authorized delivery action (driver lookup), tracking reads | ordering, payment | none | restart; retries (delivery actions are retry-safe) |
| **notification-service** | new notifications (lag accumulates) | everything else | none (Kafka retains 7 days) | restart; consumer catches up |
| **gateway** | all client traffic | internal processing (consumers keep running) | none | restart; customer app shows offline state and recovers (E2E-tested) |
| **SeaweedFS (S3)** | image uploads and image display | everything else | uploaded images (volume) | restart |

### Labs
[OPS-04 Kafka outage during checkout](labs/devops-labs.md#ops-04-kafka-outage-during-checkout), [RD-05 Restart Redis with and without AOF](labs/redis-labs.md#rd-05-restart-redis-with-and-without-aof), [DS-06 Repeat delivery completion with a service down](labs/distributed-systems-labs.md#ds-06-repeat-delivery-completion-with-a-service-down), [E2E-03 Failure screenshot and offline recovery](labs/e2e-labs.md#e2e-03-failure-screenshot-and-offline-recovery).

---

## Chapter 3 — Resilience patterns: timeouts, retries, breakers, bulkheads, shedding

### 1. Why this exists
Dependencies fail; patterns decide whether the failure stays local.

### 2. Core concept — timeouts (bound waiting), retries with exponential backoff + jitter (only idempotent operations, with a budget), circuit breakers (fail fast while a dependency is broken), bulkheads (separate pools per dependency), load shedding (reject early when overloaded), graceful degradation (serve partial functionality).

### 3. Mental model — protect the caller first; a caller that hangs spreads the failure upstream.

### 4. Delivery Plus mapping — see [Book 09 Ch. 7](09-distributed-systems.md#chapter-7--timeouts-retries-jitter-backpressure-circuit-breakers-and-bulkheads): client timeout 15 s and Kafka handler retries exist; internal timeouts (#6), gateway timeouts (#38), breakers and bulkheads don't.
### 5. Example — degrade tracking: if driver-service is down, `GET /tracking/delivery/:id` could still return the delivery status (it already has it) with `location: null` and a "location unavailable" flag, instead of failing.
### 6. Failure scenario — retries without jitter after a Redis restart: every consumer and every rate-limited request retries in lockstep, recreating the overload.
### 7. Trade-offs — breakers can trip on transient blips and cut a healthy dependency; tune thresholds per dependency.
### 8. Performance — timeouts cap latency; retries multiply load.
### 9. Security — load shedding protects against abuse.
### 10. Operations — every pattern needs a metric: timeouts fired, breaker state, shed requests.

### 11. Lab — [DS-12 Retry storm](labs/distributed-systems-labs.md#ds-12-retry-storm).
### 12. Verification — jitter flattens synchronized retries in your simulation.

### 13. Interview questions
- *Intermediate:* When is a retry harmful?
- *Advanced:* Circuit breaker states?
- *Senior:* Which Delivery Plus calls should never be retried automatically?

### 14. Senior discussion
Rate limiting fails closed when Redis is down. Would you change that to fail open for some routes? Which, and why?

---

## Chapter 4 — Graceful degradation and recovery

### 1. Why this exists
Users prefer a partially working app to an error screen.

### 2. Core concept — decide in advance what each feature does when a dependency is gone: hide it, serve stale data, queue the action, or fail clearly.
### 3. Mental model — classify features as critical (checkout), important (status), nice-to-have (images, notifications).
### 4. Delivery Plus mapping — **CURRENT:** the customer app shows an offline state and recovers without losing the session when the gateway is unreachable (`offline-recovery.yaml`); it keeps showing cached data (`keepPreviousData` in `use-resource.ts`). **Missing:** server-side degradation (menu from cache when PostgreSQL is down; ordering disabled clearly when Kafka is down instead of 500s).
### 5. Example — when Kafka is down, order-service could refuse new orders with a clear 503 ("ordering temporarily unavailable") instead of committing orders whose events will be lost — or, with an outbox, accept them safely.
### 6. Failure scenario — a "degraded" path that is never tested fails when needed (it's code too).
### 7. Trade-offs — degradation logic adds code paths; keep it small and tested.
### 8. Performance — stale caches are fast.
### 9. Security — degraded modes must not skip authorization.
### 10. Operations — feature flags/kill switches let operators disable features during incidents.

### 11. Lab — [E2E-03 Failure screenshot and offline recovery](labs/e2e-labs.md#e2e-03-failure-screenshot-and-offline-recovery).
### 12. Verification — you can list what the customer sees in each of the Chapter 2 outages.

### 13. Interview questions
- *Senior:* Design degraded modes for checkout during a Kafka outage, before and after an outbox exists.

### 14. Senior discussion
Is "accept the order and reconcile later" acceptable for food delivery? What would customers experience in the worst case?

---

## Chapter 5 — Backups, disaster recovery, RPO and RTO

### 1. Why this exists
Some failures destroy data: disk loss, a bad migration, an accidental `DELETE`, ransomware.

### 2. Core concept — RPO (max acceptable data loss), RTO (max acceptable downtime), backup types (Book 05 Ch. 8), restore drills, recovery runbooks, DR sites/regions.
### 3. Mental model — define RPO/RTO per data class, then choose mechanisms that meet them.
### 4. Delivery Plus mapping — **NOT IMPLEMENTED** (issue #16). Proposed classes:
| Data | RPO | RTO | Mechanism (FUTURE) |
| --- | --- | --- | --- |
| payments, orders | ≤ 1 min | ≤ 1 h | PITR (WAL archiving) |
| credentials, profiles | ≤ 15 min | ≤ 1 h | PITR |
| notifications | ≤ 24 h | ≤ 1 day | daily dump |
| Redis (carts, markers) | ≤ 1 s (AOF) | minutes | AOF + replica |
| Kafka events | retention-bound | minutes | RF 3 |
| S3 images | ≤ 24 h | ≤ 1 day | bucket versioning/replication |
### 5. Example — [OPS-07](labs/devops-labs.md#ops-07-backup-and-restore-one-service-database).
### 6. Failure scenario — restoring orders but not payments to the same point in time: orders say CONFIRMED, payments missing.
### 7. Trade-offs — tighter RPO/RTO = more cost and complexity.
### 8. Performance — backups load the primary unless taken from a replica.
### 9. Security — backups are a data breach waiting to happen if unencrypted.
### 10. Operations — monthly restore drills, documented.

### 11. Lab — [OPS-07 Backup and restore one service database](labs/devops-labs.md#ops-07-backup-and-restore-one-service-database).
### 12. Verification — you measure your actual RTO for one database.

### 13. Interview questions
- *Intermediate:* RPO vs RTO?
- *Advanced:* Why must cross-service restores be point-in-time consistent?
- *Senior:* DR plan for Delivery Plus.

### 14. Senior discussion
What is the realistic worst-case data loss today, and how would you explain it to the business?

---

## Chapter 6 — Incident response and postmortems

### 1. Why this exists
Incidents will happen; a practised response shortens them and a blameless review prevents repeats.

### 2. Core concept — detection → triage (severity) → roles (incident commander, communicator, investigators) → mitigation first (rollback, restart, disable) → resolution → **blameless postmortem** (timeline, impact, root causes, contributing factors, action items with owners).
### 3. Mental model — mitigate before you understand; understand before you close.
### 4. Delivery Plus mapping — runbooks: `docs/runbooks/` (local stack troubleshooting); the case studies in this library are postmortem-shaped. **NOT IMPLEMENTED:** on-call, paging, status page.
### 5. Example postmortem outline — use [case study 09](case-studies/09-driver-availability-lifecycle.md) as a model: symptom, root cause, why it looked reasonable, impact, fix, tests, remaining risks.
### 6. Failure scenario — fixing the symptom during the incident and never writing the postmortem: the same bug returns in a different form.
### 7. Trade-offs — full postmortems for every incident are heavy; use a lightweight template for minor ones.
### 8. Performance — n/a.
### 9. Security — security incidents need a separate, confidential process.
### 10. Operations — track action items to completion; most postmortems fail there.

### 11. Lab — write a postmortem for the duplicate "Order Confirmed" notifications using [case study 06](case-studies/06-in-memory-idempotency.md) as input.
### 12. Verification — your action items are specific, owned, and include a test.

### 13. Interview questions
- *Intermediate:* What does "blameless" mean?
- *Senior:* Run an incident: customers report orders stuck at "Ready for pickup" for 20 minutes.

### 14. Senior discussion
How do you balance feature work against postmortem action items?

---

## Chapter 7 — Chaos engineering and scenario playbooks

### 1. Why this exists
You learn how a system fails by making it fail — on purpose, safely.

### 2. Core concept — hypothesis ("if Redis restarts, no notification is duplicated"), controlled blast radius, measurement, abort conditions, then automate.
### 3. Mental model — chaos experiments are tests for your failure handling.
### 4. Delivery Plus mapping — **CURRENT:** manual chaos already used to verify retry-safe deliveries (services stopped mid-flow) and offline recovery (gateway stopped in E2E).
### 5. Playbooks to rehearse locally

| Scenario | Inject | Expected (today) | Lab |
| --- | --- | --- | --- |
| Kafka outage | `dc stop kafka` during checkout | orders commit, publish fails → 500 (or replay); events lost; consumers resume after restart | [OPS-04](labs/devops-labs.md#ops-04-kafka-outage-during-checkout) |
| Redis restart | `dc restart redis` | carts and markers survive (AOF); brief 500s on Redis-dependent routes | [RD-05](labs/redis-labs.md#rd-05-restart-redis-with-and-without-aof) |
| Payment failure | `simulateFailure: true` | payment FAILED, order FAILED, one event | [DS-08](labs/distributed-systems-labs.md#ds-08-declined-payment-end-to-end) |
| Database failure | `dc stop postgres` | writes fail; readiness changes where implemented; recovery on restart | [OPS-08](labs/devops-labs.md#ops-08-healthcheck-and-dependency-failure) |
| Service crash | `dc kill driver-service` during `complete` | request fails; retry releases driver | [DS-06](labs/distributed-systems-labs.md#ds-06-repeat-delivery-completion-with-a-service-down) |
| Stale location | stop sending locations for 300 s | `driver:location:*` expires; tracking returns `location: null` | [RD-06](labs/redis-labs.md#rd-06-redis-geo-nearest-drivers) (variant) |
| Consumer lag | stop notification-service, place orders | lag grows, drains on restart; no duplicates | [KF-06](labs/kafka-labs.md#kf-06-consumer-lag) |

### 6–10. See each lab's failure, trade-off and operations notes.

### 11. Lab — run all seven playbooks and record the actual outcome next to the expected one.
### 12. Verification — any difference between expected and actual is either a bug (open an issue) or a gap in this table (fix the book).

### 13. Interview questions
- *Advanced:* What makes a chaos experiment safe?
- *Senior:* Which experiment would you automate in CI first?

### 14. Senior discussion
Should chaos experiments run against the E2E stack in CI, or only in a staging environment with realistic traffic?

---

[Library index](README.md) · Previous: [Book 25](25-payment-systems.md) · Next: [Book 27 — Advanced Data Patterns](27-advanced-data-patterns.md)
