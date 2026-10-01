# Book 09 — Distributed Systems

[Library index](README.md) · Previous: [Book 08](08-idempotency-and-distributed-operations.md) · Next: [Book 10 — Microservices & Domain Design](10-microservices-and-domain-design.md)

**Level:** Advanced · **Prerequisites:** [Book 04](04-database-fundamentals.md), [Book 07](07-kafka.md), [Book 08](08-idempotency-and-distributed-operations.md).

Delivery Plus is a distributed system the moment an order spans order-service, cart-service, payment-service, Kafka, delivery-service and driver-service — twelve processes, three stateful systems, one network. This book explains why that is fundamentally harder than one process, using real incidents from this codebase as case studies.

**Labs:** [distributed-systems-labs.md](labs/distributed-systems-labs.md).

---

## Chapter 1 — What makes distributed systems hard

### 1. Why this exists
In one process, a function call either returns or throws. Across a network, it can also *hang*, *succeed without telling you*, *arrive twice*, or *arrive late and out of order*.

### 2. Core concept — the fallacies of distributed computing
The network is reliable · latency is zero · bandwidth is infinite · the network is secure · topology doesn't change · there is one administrator · transport cost is zero · the network is homogeneous. Every one of them is false, and most production incidents come from code that assumed one of them.

**Partial failure**: some components work while others don't — and you often can't tell which.

### 3. Mental model
```text
order-service ──HTTP──► payment-service
     outcomes: ✔ ok · ✘ error · ⏳ hang · ✔? succeeded, response lost · ✔✔ executed twice (retry)
```
Design every remote interaction for all five outcomes.

### 4. Delivery Plus mapping — real partial failures from this project
| Incident | Partial failure | Case study |
| --- | --- | --- |
| Failed payment → 500 | two writers (HTTP sync + consumer) disagreed on the target state | [01](case-studies/01-failed-payment-race.md) |
| Duplicate "Order Confirmed" | two writers both succeeded | [06](case-studies/06-in-memory-idempotency.md) |
| Driver stuck BUSY | delivery written, driver release failed, retry rejected | [09](case-studies/09-driver-availability-lifecycle.md) |
| Fresh Kafka crashed driver-service | consumer started before its topic existed | [Book 07 Ch. 2](07-kafka.md#chapter-2--the-core-model-broker-topic-partition-record-key-offset) (`ensureTopics`) |

### 5. Example — the checkout call chain, each hop can fail independently
```text
App → Gateway → order-service → cart-service (GET cart) → restaurant-service (status)
                     → PostgreSQL (order) → cart-service (DELETE cart) → Kafka (order.created)
App → payment-service → order-service (GET order) → PostgreSQL (payment) → Kafka + order-service (status)
```

### 6. Failure scenario
order-service saved the order, then `clearCart` failed: the customer has an order **and** a full cart; tapping "Place order" again creates a second order (unless the same idempotency key is reused).

### 7. Trade-offs — fewer hops = fewer failure points; that is a real argument for coarser services ([Book 10](10-microservices-and-domain-design.md)).
### 8. Performance — latency adds up across hops; tail latency multiplies (the slowest of N calls dominates).
### 9. Security — every hop is an authentication boundary ([Book 17](17-security-engineering.md)).
### 10. Operations — partial failures need correlation across services to diagnose ([Book 20](20-observability.md)).

### 11. Lab
[DS-09 Partial failure during checkout](labs/distributed-systems-labs.md#ds-09-partial-failure-during-checkout) — stop cart-service at the right moment.

### 12. Verification
You produce "order exists, cart not cleared" and explain which retry behaviour is then safe.

### 13. Interview questions
- *Beginner:* What is partial failure?
- *Intermediate:* Name three fallacies of distributed computing and where Delivery Plus is exposed to them.
- *Advanced:* Why is "succeeded but response lost" the hardest case?
- *Senior:* How do you decide how many network hops a user request may have?

### 14. Senior discussion
Checkout touches four services synchronously. Which hops would you remove or make asynchronous first, and what consistency would you give up?

---

## Chapter 2 — Time, clocks and ordering

### 1. Why this exists
"Which happened first?" is easy in one process and ambiguous across machines.

### 2. Core concept
- **Wall clocks** drift and jump (NTP corrections). Two machines' timestamps are not comparable to the millisecond.
- **Monotonic clocks** never go backwards — use them to measure durations, not to compare events across hosts.
- **Logical ordering**: Lamport clocks, vector clocks; or a single sequencer (a database, a Kafka partition) that defines order.

### 3. Mental model
Don't compare timestamps from different machines to decide order. Let one authority order things.

### 4. Delivery Plus mapping
- **CURRENT, good:** time-based decisions use *one* clock: payment leases compare against PostgreSQL's `now()` (`acquireSideEffectsLease`); idempotency leases expire on the Redis server's clock (`PX` in Lua). App servers' clocks don't matter.
- **CURRENT:** per-order ordering comes from the Kafka partition (key = `orderId`), not from `timestamp` fields.
- **CURRENT, clock-dependent:** internal service authentication rejects requests whose timestamp differs by more than 300 s (`MAX_CLOCK_SKEW_SECONDS` in `services/user-service/src/guards/internal-auth.guard.ts`) — skewed clocks break registration.
- **CURRENT, clock-dependent:** JWT expiry (`exp`) is checked against each verifying service's clock.

### 5. Example
Two events: `delivery.picked_up` at `12:00:00.100` from host A, `delivery.completed` at `12:00:00.050` from host B (B's clock is 80 ms behind). Sorting by timestamp says "completed before picked up". The partition order says the truth.

### 6. Failure scenario
A driver's phone with a wrong clock sends locations with `updatedAt` in the future; a "newest location wins" rule keeps the bad one forever. Tracking stores the server-observed time instead (`updatedAt` set by tracking-service).

### 7. Trade-offs — single sequencer = simple ordering, a bottleneck and a single point; logical clocks = no bottleneck, complex.
### 8. Performance — n/a.
### 9. Security — timestamp windows (300 s) bound replay attacks; nonces close them completely within the window.
### 10. Operations — run NTP on every host; alert on skew.

### 11. Lab
Change your local clock offset mentally: if auth-service's clock is 6 minutes ahead, what fails? Find the line that decides.

### 12. Verification
You point to `MAX_CLOCK_SKEW_SECONDS` and explain the registration failure.

### 13. Interview questions
- *Beginner:* Why not sort events by timestamp?
- *Intermediate:* Monotonic vs wall clock?
- *Advanced:* What is a Lamport clock?
- *Senior:* Which components of Delivery Plus are clock-sensitive, and how would you test that?

### 14. Senior discussion
ETA promises, lease expiry and token expiry all depend on time. Where would you centralise time decisions?

---

## Chapter 3 — Consistency models, CAP and PACELC

### 1. Why this exists
"Is the data correct?" has several meanings once data lives in several places.

### 2. Core concept
- **Strong (linearizable)**: every read sees the latest write, as if there were one copy.
- **Read-your-writes**: you see your own updates.
- **Causal**: if A caused B, everyone sees A before B.
- **Eventual**: replicas converge if writes stop.
- **CAP**: during a network **P**artition you must choose **C**onsistency (refuse) or **A**vailability (answer, possibly stale).
- **PACELC**: if Partition → A or C; **E**lse (normal operation) → **L**atency or **C**onsistency.

### 3. Mental model
Consistency is a per-feature product decision: "may the customer see a stale order status for 10 seconds?" (yes) vs "may two payments succeed?" (never).

### 4. Delivery Plus mapping
| Data | Model today | Why |
| --- | --- | --- |
| Order status (within order-service) | strong (one PostgreSQL row, CAS) | **CURRENT** |
| Order status as seen by notification-service | eventual (Kafka) | **CURRENT** |
| Delivery status in the customer app | eventual, ≤ 10 s (polling) | **CURRENT** |
| Menu / restaurant via Redis cache | eventual, until invalidation | **CURRENT** |
| Payment uniqueness per order | strong (unique index) | **CURRENT** |
| Driver availability vs delivery assignment | two services, synchronously updated, can diverge on failure | **PARTIAL** (#33) |

### 5. Example — read-your-writes on the customer app: after "Place order", the app navigates to the order it just received in the response, not to a list that might be served from a stale cache.
### 6. Failure scenario — strong consistency where it isn't needed (synchronous notification on checkout) makes checkout fail when notifications are down.
### 7. Trade-offs — every "C" choice costs availability or latency; every "A" choice needs reconciliation.
### 8. Performance — strong consistency often means coordination round trips (locks, quorums).
### 9. Security — authorization decisions must not use stale data (e.g. a revoked owner reading via cache).
### 10. Operations — document the consistency contract per API so support knows "wait 10 seconds" is expected behaviour.

### 11. Lab
Measure the delay between `delivery.completed` being published and the customer app showing "Delivered" (polling interval). Then measure notification creation delay from Kafka timestamps.

### 12. Verification
Your numbers stay within the polling interval and consumer processing time; you can explain the worst case.

### 13. Interview questions
- *Beginner:* What is eventual consistency?
- *Intermediate:* Explain CAP with a Delivery Plus example.
- *Advanced:* What does PACELC add to CAP?
- *Senior:* Choose consistency models for each Delivery Plus feature and defend them.

### 14. Senior discussion
If PostgreSQL gets a read replica, which reads may go to it, and which must stay on the primary?

---

## Chapter 4 — Replication, quorum and leader election

### 1. Why this exists
To survive machine failure, data is copied; copies must agree on what is true and who is in charge.

### 2. Core concept
- **Leader-based replication**: one leader accepts writes; followers copy (PostgreSQL streaming replication, Kafka partitions, Redis replicas).
- **Quorum**: with N copies, write to W and read from R with W + R > N to guarantee overlap.
- **Leader election**: choosing a new leader when the old one fails (ZooKeeper/KRaft for Kafka, Patroni for PostgreSQL, Sentinel for Redis).
- **Split brain**: two nodes both believe they are leader.

### 3. Mental model
Replication protects against *loss*; consensus protects against *disagreement*.

### 4. Delivery Plus mapping
- **CURRENT:** everything is single-node (one PostgreSQL, one Redis, one Kafka broker + one ZooKeeper). No replication, no election.
- **CURRENT:** Kafka still uses ZooKeeper for cluster metadata (`docker-compose.base.yml`); newer Kafka uses KRaft (built-in consensus) — **FUTURE** migration.
- Production equivalents are covered in [Book 19](19-kubernetes.md) and [Book 26](26-reliability-engineering.md).

### 5. Example — Kafka with RF=3: the controller elects a new partition leader from the ISR when a broker dies; producers and consumers reconnect automatically.
### 6. Failure scenario — asynchronous replication + failover = the new leader lacks the last writes (lost processed markers in Redis → duplicate side effects; lost commits in PostgreSQL → missing orders).
### 7. Trade-offs — synchronous replication = no loss, higher latency, availability depends on replicas.
### 8. Performance — quorum writes wait for the slowest of W replicas.
### 9. Security — replicas hold full copies; secure them equally.
### 10. Operations — test failover; untested failover usually fails.

### 11. Lab
Thought lab: draw a 3-broker Kafka cluster with RF=3, min ISR=2; mark which failures lose writes, which block writes, which are invisible.

### 12. Verification
Your drawing shows: 1 broker down → invisible; 2 down → writes rejected; disk loss on one → no data loss.

### 13. Interview questions
- *Beginner:* Why replicate?
- *Intermediate:* What is a quorum?
- *Advanced:* What is split brain and how is it prevented?
- *Senior:* Which Delivery Plus stateful component would you make highly available first?

### 14. Senior discussion
Is high availability worth it before there are real customers? What is the cheapest change with the biggest reliability gain?

---

## Chapter 5 — Distributed transactions, 2PC and sagas

### 1. Why this exists
Checkout must update order-service, payment-service and (later) a payment provider. There is no shared transaction.

### 2. Core concept
- **Two-phase commit (2PC)**: a coordinator asks all participants to *prepare*, then *commit*. Atomic, but blocking if the coordinator dies, and rarely supported across services/brokers.
- **Saga**: a sequence of local transactions; each step publishes an event or calls the next; failures trigger **compensating** actions (refund, cancel).
- **Orchestration** (a coordinator tells each step what to do) vs **choreography** (each service reacts to events).

### 3. Mental model
A saga is "do, and know how to undo". Compensation is a *new* business action, not a rollback: a refund, not a deleted payment.

### 4. Delivery Plus mapping
- **CURRENT — an implicit saga:** the client orchestrates checkout (`delivery-plus-customer-app/src/services/checkout.ts`): create order → create payment → process payment; payment-service then syncs the order (`PAYMENT_PENDING` → `CONFIRMED`/`FAILED`). Failure = order ends `FAILED`, which is itself a terminal "compensated" state.
- **CURRENT — choreography:** order-service converges from `payment.*` and `delivery.*` events.
- **MISSING compensation — PLANNED (#53):** a paid order that is later cancelled is not refunded automatically; a cancelled order with an active delivery is not coordinated with delivery-service.
- **NOT USED:** 2PC.

### 5. Example — a choreographed cancellation saga (FUTURE design)
```text
order.cancelled ──► payment-service: if COMPLETED → refund → payment.refunded
               └──► delivery-service: if active → cancel delivery → free driver → delivery.cancelled
```

### 6. Failure scenario — a saga step fails after earlier steps succeeded and no compensation exists → money taken for an order that will never arrive (today: an admin refund, manually).
### 7. Trade-offs
| | 2PC | Orchestrated saga | Choreographed saga |
| --- | --- | --- | --- |
| Atomicity | yes | eventual | eventual |
| Coupling | high | central coordinator | distributed, implicit |
| Visibility | good | good (one place) | hard (follow events) |
| Failure handling | blocking | explicit | emergent |

### 8. Performance — sagas don't hold locks across services.
### 9. Security — compensations (refunds) are high-privilege actions; authorize and audit them.
### 10. Operations — sagas need state you can query ("where is this order's cancellation?").

### 11. Lab
[DS-10 Saga simulation: cancel a paid order](labs/distributed-systems-labs.md#ds-10-saga-simulation-cancel-a-paid-order).

### 12. Verification
You show the current gap (paid, cancelled, not refunded) and write the event sequence that would close it.

### 13. Interview questions
- *Beginner:* What is a saga?
- *Intermediate:* Orchestration vs choreography?
- *Advanced:* Why is compensation not the same as rollback?
- *Senior:* Design order cancellation for Delivery Plus (issue #53).

### 14. Senior discussion
Today the *client app* sequences order → payment. Should a backend orchestrator own checkout instead? What does that change for retries and for a future web client?

---

## Chapter 6 — Outbox, inbox and change data capture

### 1. Why this exists
"Update the database and publish an event" cannot be atomic across PostgreSQL and Kafka — unless you put the event in the database first.

### 2. Core concept
- **Transactional outbox**: write the event to an `outbox` table in the same transaction as the state change; a relay publishes it and marks it sent.
- **Inbox**: record processed event IDs in the consumer's database in the same transaction as the effect.
- **CDC (change data capture)**: read the database's WAL (e.g. Debezium) and turn changes or outbox rows into events.

### 3. Mental model
```text
DB transaction
 ├── update state
 └── write outbox event
        ↓
      relay (poll or CDC)
        ↓
      Kafka  ──► consumer: BEGIN; INSERT inbox(eventId); apply effect; COMMIT
```

### 4. Delivery Plus mapping
- **NOT IMPLEMENTED (PLANNED, #98):** outbox. order-service and delivery-service publish after commit; a crash in between loses the event.
- **PARTIAL substitute in payments:** status markers + lease emulate an outbox per row (Book 08 Ch. 6).
- **NOT IMPLEMENTED (FUTURE):** inbox (Redis markers are used instead), CDC.
- Full design: [Book 27](27-advanced-data-patterns.md), [case study 13](case-studies/13-transactional-outbox.md), [ADR 0010](adrs/0010-transactional-outbox.md).

### 5. Example — see [DS-11](labs/distributed-systems-labs.md#ds-11-outbox-simulation).
### 6. Failure scenario — relay publishes, crashes before marking sent → re-publishes; consumers must be idempotent (they are, by `eventId`).
### 7. Trade-offs — outbox: one more table, a relay process, polling latency; CDC: lower latency, a new infrastructure component (Kafka Connect/Debezium).
### 8. Performance — polling relays add ~100 ms–1 s latency; CDC is near real-time.
### 9. Security — CDC reads the WAL and sees *everything*; restrict it to the outbox table.
### 10. Operations — monitor outbox backlog (rows not yet sent) like consumer lag.

### 11. Lab
[DS-11 Outbox simulation](labs/distributed-systems-labs.md#ds-11-outbox-simulation).

### 12. Verification
Killing the "service" between the DB commit and the publish loses nothing in the outbox version.

### 13. Interview questions
- *Beginner:* What problem does the outbox solve?
- *Intermediate:* Why do outbox consumers still need idempotency?
- *Advanced:* Polling relay vs CDC?
- *Senior:* Roll out an outbox to order-service without downtime or double-publishing.

### 14. Senior discussion
Once an outbox exists, should delivery-service stop calling order-service over HTTP and rely on events only?

---

## Chapter 7 — Timeouts, retries, jitter, backpressure, circuit breakers and bulkheads

### 1. Why this exists
One slow dependency can consume every thread, connection and retry budget of every caller — a cascading failure.

### 2. Core concept
- **Deadline**: total time budget for a request, propagated to downstream calls.
- **Retry with exponential backoff + jitter**: spread retries in time.
- **Retry budget**: cap retries as a fraction of traffic.
- **Backpressure**: slow producers down when consumers can't keep up.
- **Load shedding**: reject excess work early (429/503) instead of queuing forever.
- **Circuit breaker**: after N failures, fail fast for a cool-down period instead of calling a broken dependency.
- **Bulkhead**: isolate resources (pools) per dependency so one can't exhaust all.

### 3. Mental model
```text
Healthy:   caller ──► dependency (5 ms)
Degraded:  caller ──► dependency (30 s, no timeout) ── callers pile up ── pool exhausted ── caller fails too
Protected: caller ──► timeout 2 s ─► breaker opens ─► fail fast ─► caller stays healthy, degrades one feature
```

### 4. Delivery Plus mapping
| Mechanism | Status |
| --- | --- |
| Client timeout 15 s | **CURRENT** (customer app) |
| Service-to-service timeouts | **NOT IMPLEMENTED** (#6) |
| Gateway upstream timeouts | **NOT IMPLEMENTED** (#38) |
| Kafka handler retries with backoff (no jitter) | **CURRENT** |
| Kafka backpressure | **CURRENT, implicit**: consumers pull at their own pace; lag absorbs bursts |
| Load shedding | **PARTIAL**: rate limits (429) on a few routes |
| Circuit breakers, bulkheads | **NOT IMPLEMENTED** |

### 5. Example
```ts
// FUTURE: a fetch with a deadline (Node 18+)
const res = await fetch(url, { signal: AbortSignal.timeout(2000), headers });
```

### 6. Failure scenario
driver-service hangs: every `assignDriver`, `pickup` (driver lookup for authorization) and tracking call waits indefinitely; delivery-service and tracking-service requests pile up; the gateway keeps connections open; the customer app times out at 15 s and the user retries — doubling load.

### 7. Trade-offs — breakers need tuning (thresholds, half-open probes) and can open on false positives; timeouts too short cause needless failures.
### 8. Performance — timeouts bound tail latency; retries increase load (each retry is a new request).
### 9. Security — load shedding is a DoS defence.
### 10. Operations — every timeout and breaker state change must be logged/metric'd, or you will never know they fired.

### 11. Lab
[DS-12 Retry storm](labs/distributed-systems-labs.md#ds-12-retry-storm).

### 12. Verification
Without jitter, your simulated clients retry in synchronised waves; with jitter, the load curve flattens.

### 13. Interview questions
- *Beginner:* Why add jitter to retries?
- *Intermediate:* What does a circuit breaker do?
- *Advanced:* How do you propagate a deadline across services?
- *Senior:* Design timeout values for app → gateway → delivery → driver.

### 14. Senior discussion
Should the timeout/retry policy live in each service client, in a shared library (issue #6), or in a service mesh?

---

## Chapter 8 — Service discovery and service identity

### 1. Why this exists
Services must find each other and prove who they are.

### 2. Core concept
- **Discovery**: DNS, a registry (Consul), or the orchestrator (Kubernetes Services).
- **Identity**: shared secrets (HMAC), tokens (JWT with a service subject), mTLS certificates (SPIFFE), cloud IAM.
- **Authorization** of service calls: what may *this service* do?

### 3. Mental model
Inside the network is not "trusted". Every call should carry a verifiable identity.

### 4. Delivery Plus mapping — **CURRENT**
- Discovery: Docker Compose DNS (`http://order-service:3006`), URLs from env vars (`ORDER_SERVICE_URL`, …).
- Identity, two mechanisms:
  1. **System JWTs**: payment-, delivery- and tracking-service mint short-lived JWTs with `role: ADMIN` and `sub: system:<service>` (`services/*/src/common/system-token.service.ts`) signed with the shared `JWT_SECRET`. Receiving services can't distinguish a system token from a human admin, and any holder of `JWT_SECRET` can mint one ([case study 18](case-studies/18-system-token.md)).
  2. **HMAC request signing** for auth → user profile creation (`shared/src/nest/auth/internal-auth.ts`, `services/user-service/src/guards/internal-auth.guard.ts`): signature over method, path, timestamp, nonce and body hash, with a dedicated secret, timestamp window and Redis nonce. Documented in `docs/adr/001-internal-service-authentication.md`.
- **Caller-identity forwarding:** for ownership checks delivery-service forwards the *user's* token to order-service (`assertReadableBy`) instead of using its system token — the order-service rules stay the source of truth.

### 5. Example — compare a system token's payload with a customer's: same structure, `role: "ADMIN"`.
### 6. Failure scenario — a leaked `JWT_SECRET` lets an attacker mint ADMIN tokens for *every* service (all share it).
### 7. Trade-offs — shared-secret JWTs: simple, coarse; per-service keys/asymmetric signing: finer, more key management; mTLS: strong transport identity, needs a PKI or mesh.
### 8. Performance — HMAC and JWT verification are microseconds.
### 9. Security — see [Book 17](17-security-engineering.md) for the recommended evolution (scoped service roles, asymmetric keys).
### 10. Operations — rotating the shared JWT secret is a coordinated all-service deploy.

### 11. Lab
[SEC-03 Mint and inspect a system token](labs/security-labs.md#sec-03-mint-and-inspect-a-system-token).

### 12. Verification
You show that a hand-minted `role: ADMIN` token (with the dev secret) can list available drivers — and explain why that's a design risk, not a bug.

### 13. Interview questions
- *Beginner:* How does order-service find cart-service?
- *Intermediate:* Why forward the user's token for ownership checks?
- *Advanced:* HMAC signing vs JWT for service calls?
- *Senior:* Design service identity for Delivery Plus on Kubernetes.

### 14. Senior discussion
Should system tokens carry `role: ADMIN`, or a distinct `role: SERVICE` with explicit per-route permissions? What has to change in every guard?

---

## Chapter 9 — Distributed locks, leases and fencing tokens

### 1. Why this exists
Sometimes exactly one worker must do something (settle a payment, process an event, run a migration).

### 2. Core concept
- A **lease** is a lock with an expiry, so a dead holder doesn't block forever.
- A **fencing token** is a monotonically increasing number issued with each lease; the protected resource rejects writes carrying an older token than it has seen.
- Without fencing, a paused holder (GC, network) can wake up after expiry and write concurrently with the new holder.

### 3. Mental model
```text
A: lease (token 33) ── long GC pause ─────────────── write(33) ✘ rejected (resource saw 34)
B:            lease expires → lease (token 34) ── write(34) ✔
```

### 4. Delivery Plus mapping
- **CURRENT, owner-checked:** Kafka idempotency leases carry a random owner token; only the owner can release; `markProcessed` reports whether the caller still owned the lease (`shared/src/kafka/durable-event-idempotency.scripts.ts`). Not a monotonic fencing token, but stale releases can't break other holders.
- **CURRENT, unfenced:** payment side-effect lease (`sideEffectsLeaseUntil`) — no owner, unconditional release (issue #19).
- **CURRENT, CAS as fencing:** status CAS (`WHERE status = :from`) acts like a fencing check — a stale writer's update affects 0 rows.

### 5. Example — the payment lease fix (sketch, FUTURE)
```sql
-- acquire: return a token
UPDATE payments SET "sideEffectsLeaseUntil" = now() + interval '30 s', "leaseToken" = gen_random_uuid()
WHERE id = $1 AND ("sideEffectsLeaseUntil" IS NULL OR "sideEffectsLeaseUntil" < now())
RETURNING "leaseToken";
-- release / mark: only with your token
UPDATE payments SET "sideEffectsLeaseUntil" = NULL WHERE id = $1 AND "leaseToken" = $2;
```

### 6. Failure scenario — see issue #19 (Book 08 Ch. 6).
### 7. Trade-offs — lease length vs recovery time: long leases delay recovery after crashes; short leases expire under normal slowness.
### 8. Performance — one extra column and condition.
### 9. Security — lease tokens are not secrets but must be unguessable if callers could otherwise forge them.
### 10. Operations — log lease expiry while the holder was still working ("lease lost") — it means your timeouts are wrong.

### 11. Lab
[RD-07 Idempotency lease with Lua](labs/redis-labs.md#rd-07-idempotency-lease-with-lua).

### 12. Verification
You demonstrate that a stale holder cannot release a newer holder's lease in the Redis implementation, and that it can in the payment lease.

### 13. Interview questions
- *Beginner:* Why do locks need an expiry?
- *Intermediate:* What is a fencing token?
- *Advanced:* Why is Redlock controversial?
- *Senior:* Which Delivery Plus operations truly need mutual exclusion, and which only need idempotency?

### 14. Senior discussion
Mutual exclusion vs idempotency: if every effect were idempotent, would you need leases at all?

---

[Library index](README.md) · Previous: [Book 08](08-idempotency-and-distributed-operations.md) · Next: [Book 10 — Microservices & Domain Design](10-microservices-and-domain-design.md)
