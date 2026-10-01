# Book 08 — Idempotency & Distributed Operations

[Library index](README.md) · Previous: [Book 07](07-kafka.md) · Next: [Book 09 — Distributed Systems](09-distributed-systems.md)

**Level:** Intermediate → Advanced · **Prerequisites:** [Book 03 Ch. 6](03-http-apis-and-web.md#chapter-6--timeouts-retries-backoff-and-rate-limiting) (timeouts), [Book 04 Ch. 6](04-database-fundamentals.md#chapter-6--concurrency-control-locks-cas-lost-updates-and-deadlocks) (CAS), [Book 07](07-kafka.md).

Idempotency is the single most important practical idea in distributed systems: every retry, redelivery, replay and double-click is safe only if the operation is idempotent. Delivery Plus implements it at five layers. This book walks through each with real code and real failure simulations.

**Labs:** [distributed-systems-labs.md](labs/distributed-systems-labs.md) (DS-01 … DS-07).

---

## Chapter 1 — What idempotency really means

### 1. Why this exists
Networks lose responses, clients retry, Kafka redelivers, operators replay. Any operation that can be repeated *will* be repeated.

### 2. Core concept
An operation is **idempotent** if performing it once or many times has the same effect: `f(f(x)) = f(x)`.
- `SET status = 'DELIVERED'` — idempotent.
- `INSERT INTO notifications …` — not idempotent.
- `balance = balance - 10` — not idempotent.

Kinds:
| Kind | Question | Delivery Plus |
| --- | --- | --- |
| **HTTP / request** | "Did I already handle *this request*?" | `Idempotency-Key` on orders and payments |
| **Business / state** | "Is the world already in the state you're asking for?" | status CAS, "same status → no-op", retry-safe delivery actions |
| **Event / consumer** | "Did my consumer group already handle *this event*?" | Redis markers per `{group}:{eventId}` |
| **Producer** | "Did the broker already store this record?" | not enabled (consumer side handles duplicates) |
| **Side-effect** | "Did I already do *this external effect* for this state?" | payment `publishedEventStatus` / `orderSyncedStatus` markers |

### 3. Mental model
> **Beginner understanding:** "Idempotency means duplicate requests are ignored."
> **Reality:** the operation may still execute several times unless the *business effect* is made idempotent; "ignoring" requires remembering what was done, atomically with doing it.
> **Production issue:** retries arrive after the server committed but before the client received the response; and concurrently, while the first attempt is still running.
> **Senior concern:** where is the "already done" record stored, how long is it kept, is it written atomically with the effect, what happens when the same key arrives with a *different* request, and what happens across regions?

### 4. Delivery Plus mapping — summary map

```text
Customer app ──(Idempotency-Key)──► order-service / payment-service   [HTTP, PostgreSQL unique index]
                                        │ status CAS                     [business]
                                        ▼
                                     Kafka (eventId = UUID v5)           [deterministic IDs]
                                        ▼
                                   consumers (Redis {group}:{eventId})   [event]
                                        ▼
                                   payment markers / delivery re-run     [side effects]
```

### 5. Example
`PATCH /api/orders/:id/status {"status":"PREPARING"}` twice: the second call finds the order already `PREPARING` and returns it without writing or publishing (`if (order.status === dto.status) return order;` in `services/order-service/src/services/orders.service.ts`).

### 6. Failure scenario
Treating "idempotent" as a property of the *endpoint* instead of the *effect*: `POST /payments/:id/process` "is idempotent" only because the payment row remembers the outcome *and* the side-effect markers remember what was already published and synced.

### 7. Trade-offs — remembering costs storage and a lookup on every call; how long you remember bounds how late a retry can be safely accepted.
### 8. Performance — one indexed lookup (PostgreSQL) or one Lua call (Redis) per operation.
### 9. Security — idempotency keys must be scoped to the caller (`customerId`), or one customer could replay another's key and read their result.
### 10. Operations — log "replayed" and "already processed" outcomes separately from normal success; they measure how often clients and brokers retry.

### 11. Lab
[DS-02 Double-submit checkout](labs/distributed-systems-labs.md#ds-02-double-submit-checkout).

### 12. Verification
Two identical `POST /api/orders` with the same key produce one order; without the key, two.

### 13. Interview questions
- *Beginner:* Is `DELETE` idempotent?
- *Intermediate:* HTTP vs business idempotency?
- *Advanced:* Why must idempotency keys be scoped per customer?
- *Senior:* What happens if a key is reused with a different body?

### 14. Senior discussion
Which layer should be the *primary* defence against double charging: the client key, the payment row state, the unique index, or the payment provider's own idempotency? (Answer: more than one — but which one is the backstop?)

---

## Chapter 2 — Timeout ambiguity and the lost acknowledgement

### 1. Why this exists
It is the root cause of most duplicates.

### 2. Core concept
After a timeout or a dropped connection, the client cannot know which of these happened:
```text
(a) request never arrived           → safe to retry
(b) arrived, failed, no response    → safe to retry
(c) arrived, SUCCEEDED, response lost → retrying repeats the effect
```
The same is true for Kafka producers (ack lost) and consumers (processed, offset commit lost).

### 3. Mental model
A timeout means **"unknown"**, never "failed".

### 4. Delivery Plus mapping
- Customer app: 15 s timeout (`delivery-plus-customer-app/src/services/api.ts`) — then the user may tap "Place order" again.
- Server keeps working after the client gives up (no server-side deadlines, issues #6 and #38).
- Kafka consumer: handler succeeds, process dies before `commitOffsets` → redelivery.

### 5. Example
```text
App ──POST /api/orders──► order-service: order saved ✔, cart cleared ✔, event published ✔
App ◄──── (mobile network drops the response) ────
App: "timeout" → user taps again → without a key: second order from … an empty cart → 400 "Cart is empty"
```
The cart clear accidentally saves you here — but the payment step has no such luck.

### 6. Failure scenario — payment: `POST /payments/:id/process` succeeds and the response is lost; a naive retry would simulate a *second* charge. Delivery Plus returns the settled result instead (Chapter 4).
### 7. Trade-offs — longer client timeouts reduce false failures but freeze the UI; shorter ones increase retries — which is only fine if they are idempotent.
### 8. Performance — server-side work continues after client timeouts, wasting capacity during overload ("work that nobody will read").
### 9. Security — attackers can exploit non-idempotent endpoints with deliberate retries (double-spend style races).
### 10. Operations — a spike of duplicates often follows a network incident, not a code change.

### 11. Lab
[DS-01 Timeout ambiguity](labs/distributed-systems-labs.md#ds-01-timeout-ambiguity).

### 12. Verification
You produce outcome (c): the client sees a timeout, the database shows the effect.

### 13. Interview questions
- *Beginner:* What does a timeout tell you?
- *Intermediate:* Which of the three outcomes is dangerous and why?
- *Advanced:* How does an idempotency key turn (c) into a safe retry?
- *Senior:* How do you design client UX for "unknown" outcomes (e.g. checkout)?

### 14. Senior discussion
Should the customer app *automatically* retry a timed-out checkout with the same key, or ask the user? What does each mean for duplicate risk and support tickets?

---

## Chapter 3 — HTTP idempotency keys

### 1. Why this exists
To make non-idempotent creation endpoints safe to retry.

### 2. Core concept
1. Client generates a unique key per *intended operation* (UUID) and sends `Idempotency-Key`.
2. Server stores the key with the result, scoped to the caller, under a **unique constraint**.
3. Repeat with the same key → return the stored result.
4. Concurrent duplicates → one insert wins; the loser catches the unique violation and returns the winner.
5. Same key, different request → reject (request fingerprint).

### 3. Mental model
The key is the identity of the *intention* "place this order", not of the HTTP request.

### 4. Delivery Plus mapping — **CURRENT**
| | Orders | Payments |
| --- | --- | --- |
| Header parsing | `services/order-service/src/common/idempotency-key.ts` (1–255 visible ASCII, single header) | `services/payment-service/src/common/idempotency-key.ts` |
| Storage | `orders."idempotencyKey"`, partial unique `UQ_orders_customer_idempotency_key` | `payments."idempotencyKey"`, `UQ_payments_customer_idempotency_key` |
| Replay | `createFromCart`: lookup first; on error, look up the winner | `createPayment`: lookup first → `replayCreate`; unique-violation → winner |
| Different request, same key | **not detected** — returns the earlier order | rejected if `orderId` differs ("Idempotency-Key was already used for a different order") |
| Retention | forever (column on the order) | forever |
| Client | one key per checkout attempt, `delivery-plus-customer-app/src/services/checkout.ts` | same |

### 5. Example
```bash
KEY=$(node -e "console.log(crypto.randomUUID())")
curl -s -X POST localhost:3000/api/orders -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY"
curl -s -X POST localhost:3000/api/orders -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY"   # same order id
```

### 6. Failure scenario
The key is stored *inside the order row*. The check "does an order with this key exist?" therefore only works once the order is committed. Two concurrent first attempts both see "no", both insert → the unique index rejects one → the loser looks up the winner. Without the unique index, both would succeed. **The constraint, not the lookup, is the guarantee.**

### 7. Trade-offs
| Design | Pro | Con |
| --- | --- | --- |
| Key column on the resource (current) | atomic with the insert, no extra table | can't store failed attempts or responses |
| Separate idempotency table (key, request hash, response, status) | replays exact response, detects body mismatch, can expire | more code; must be in the same transaction |
| Redis key with TTL | fast, expires | not transactional with the DB write |

### 8. Performance — a partial unique index only indexes rows that have a key: small and cheap.
### 9. Security — keys are scoped by `customerId`; a guessed key from another customer can't return their order.
### 10. Operations — keys never expire here; for high-volume APIs you'd expire them (24 h–7 d) to bound storage.

### 11. Lab
[DS-02 Double-submit checkout](labs/distributed-systems-labs.md#ds-02-double-submit-checkout) (sequential and concurrent variants).

### 12. Verification
10 concurrent requests with the same key → exactly one order row; the other 9 responses return the same order ID.

### 13. Interview questions
- *Beginner:* Who generates the idempotency key?
- *Intermediate:* Why check the database *and* rely on a unique index?
- *Advanced:* How do you detect a key reused with a different body?
- *Senior:* Design an idempotency table that replays the exact original response.

### 14. Senior discussion
`createFromCart` returns the earlier order for any repeat of the key, even if the cart changed. Is that the right behaviour for a customer who edited the cart after a timeout?

---

## Chapter 4 — Business idempotency with state machines and compare-and-set

### 1. Why this exists
Many operations are naturally idempotent if you phrase them as "move to state X" instead of "do X".

### 2. Core concept
- Express changes as **target states**.
- Apply them with **CAS** (`WHERE status = :from`).
- Define what happens on repeat: already at target → success, no side effects; elsewhere → explicit error or skip.

### 3. Mental model
"Make it so" is idempotent; "do it again" is not.

### 4. Delivery Plus mapping — **CURRENT**
- **Orders:** `OrdersService.updateStatus` — same status → return; CAS lost → re-read; at target → return without publishing; else 409. Events from payment/delivery go through `syncStatusFromEvent` (same status → no-op, illegal transition → logged and skipped, never thrown).
- **Payments:** `processPayment` — settled → return result (+ finish owed side effects); `PROCESSING` → 409; `PENDING` → CAS to `PROCESSING` (only one request wins), simulate, CAS to `COMPLETED`/`FAILED`.
- **Deliveries:** `advance()` in `services/delivery-service/src/services/deliveries.service.ts` — already at target → skip the write and **re-run side effects** (driver release, order sync, publish with the same eventId).
- **Drivers:** `DriverServiceClient.releaseDriver` treats "no longer BUSY" as already released (`services/delivery-service/src/common/driver-service.client.ts`).

### 5. Example
```text
complete(delivery) — first attempt:   IN_TRANSIT → DELIVERED (CAS) ✔, release driver ✘ (driver-service down) → 500
complete(delivery) — retry:           already DELIVERED → skip write → release driver ✔ → sync order ✔ → publish (same eventId) ✔ → 201
```
Before this design, the retry got 409 and the driver stayed BUSY forever ([case study 09](case-studies/09-driver-availability-lifecycle.md)).

### 6. Failure scenario
A state machine with cycles (driver AVAILABLE ↔ BUSY) is **not** naturally idempotent: "set AVAILABLE" repeated *later* (a stale retry) can undo a newer BUSY. That's why delivery-service refuses to free a driver who has another active delivery.

### 7. Trade-offs — returning success on repeat is client-friendly but can hide bugs (a client that calls `complete` in a loop); log repeats.
### 8. Performance — CAS is a single statement.
### 9. Security — state checks must happen after authorization; a repeat must still be authorized (it is: `assertAssignedDriver` runs before `advance`).
### 10. Operations — 409 rates per transition show where concurrent writers collide.

### 11. Lab
[DS-05 Concurrent order confirmation](labs/distributed-systems-labs.md#ds-05-concurrent-order-confirmation), [DS-06 Repeat delivery completion with a service down](labs/distributed-systems-labs.md#ds-06-repeat-delivery-completion-with-a-service-down).

### 12. Verification
Two concurrent confirmations publish one `order.confirmed`; a failed-then-retried `complete` leaves the driver AVAILABLE and the order DELIVERED.

### 13. Interview questions
- *Beginner:* Why is "set status to X" easier to make idempotent than "increment"?
- *Intermediate:* What does CAS return when you lose the race, and what do you do then?
- *Advanced:* Why are cyclic state machines harder?
- *Senior:* Design idempotent "cancel order" that must also refund and release a driver.

### 14. Senior discussion
`syncStatusFromEvent` silently skips illegal transitions. When is "skip and log" right, and when should it alert?

---

## Chapter 5 — Event idempotency: deterministic IDs and consumer deduplication

### 1. Why this exists
Kafka is at-least-once; consumers see duplicates from producer retries, re-publishes, redeliveries and replays.

### 2. Core concept
- **Deterministic event ID**: derived from what the event *means* (entity + type), so a re-publish has the same ID.
- **Consumer dedup**: per consumer group, remember processed IDs; claim before processing so two consumers can't process concurrently.
- **Lease**: a claim that expires (crash safety). **Processed marker**: kept for the redelivery window.

### 3. Mental model
```text
claim  ─► acquired ─► handle ─► markProcessed ─► commit
      ├─► processed ─────────────────────────► commit
      └─► in-progress ─► wait (poll) ─► …
```

### 4. Delivery Plus mapping — **CURRENT**
- IDs: `lifecycleEventId` (orders, deliveries), `paymentEventId` (payments).
- Claims: `DurableEventIdempotencyService.tryAcquire / markProcessed / release` (Lua, `shared/src/kafka/durable-event-idempotency.scripts.ts`), used by `KafkaConsumerService.handleMessage`.
- Groups with durable dedup: order-service, notification-service. A consumer without it falls back to an in-process `Set` and warns at startup.
- Retention 7 days = Kafka default retention; lease 60 s.

### 5. Example
```text
kafka:idempotency:notification-service-group:9ed7ec3f-… = "processed"   (TTL ~7 days)
kafka:idempotency:order-service-group:9ed7ec3f-…        = (absent: order-service doesn't consume order.confirmed)
```

### 6. Failure scenario — the duplicate window
```text
handler: INSERT notification (PostgreSQL COMMIT) ✔
<crash>
markProcessed ✘  → lease expires after 60 s → redelivered → acquired → INSERT again
```
Rare (milliseconds wide) but real, because the marker and the effect live in different stores. Making the effect itself idempotent (a unique constraint on `(userId, eventId)` in notifications, or an inbox table in the same DB transaction) closes it — **FUTURE**.

### 7. Trade-offs
| Approach | Atomic with effect | Shared | Cost |
| --- | --- | --- | --- |
| In-memory Set | no | no | free |
| Redis markers (current) | no | yes | 1 round trip |
| DB inbox / unique `eventId` column | **yes** | yes | 1 insert in the same transaction |

### 8. Performance — one Lua `EVAL` per event plus one to mark processed.
### 9. Security — anyone with Redis write access can suppress events by forging `processed` markers.
### 10. Operations — key count ≈ events/week × groups.

### 11. Lab
[DS-04 Duplicate payment event](labs/distributed-systems-labs.md#ds-04-duplicate-payment-event), [DS-07 Consumer crash mid-handler](labs/distributed-systems-labs.md#ds-07-consumer-crash-mid-handler).

### 12. Verification
Publishing the same `payment.completed` twice changes the order once and logs "already processed" for the second.

### 13. Interview questions
- *Beginner:* Why can't consumers trust Kafka to deliver once?
- *Intermediate:* Why must event IDs be deterministic for dedup to catch re-publishes?
- *Advanced:* Explain the duplicate window between the side effect and the marker.
- *Senior:* Inbox table vs Redis markers for a payments consumer?

### 14. Senior discussion
Should notification-service add `eventId` to the `notifications` table with a unique constraint? What does that cost for future notification types that legitimately repeat?

---

## Chapter 6 — Side effects, markers and leases (payments)

### 1. Why this exists
Settling a payment triggers effects in other systems (a Kafka event, an order update). Each must happen exactly once per state, even when requests retry concurrently and crash half-way.

### 2. Core concept
- **Per-effect markers**: record, per effect, "done for state S".
- **Lease**: only one worker performs owed effects at a time; it expires if the worker dies.
- **Resume**: a retry performs only the effects not yet marked.

### 3. Mental model
```text
payment row: status=COMPLETED, publishedEventStatus=NULL, orderSyncedStatus=NULL
retry 1: lease ✔ → publish ✔ → mark published=COMPLETED → order sync ✘ (order-service down) → release lease → 500
retry 2: lease ✔ → published already COMPLETED (skip) → order sync ✔ → mark synced → release → 200
```

### 4. Delivery Plus mapping — **CURRENT**
`completeSideEffects` in `services/payment-service/src/services/payments.service.ts` with `acquireSideEffectsLease` / `markEventPublished` / `markOrderSynced` / `releaseSideEffectsLease` in `services/payment-service/src/repositories/payments.repository.ts`. Markers are columns on `payments` (migration `001-initial-schema.ts`).

### 5. Example — see the mental model; lab DS-03 runs it.

### 6. Failure scenario — **PARTIAL** (issue #19)
The lease has no owner token. Worker A's lease expires while it is still running; worker B takes a new lease; A finishes and calls `releaseSideEffectsLease`, which clears B's lease unconditionally; worker C can now start concurrently with B. The fix is a lease token checked on release and on marker writes (a fencing token, [Book 09](09-distributed-systems.md)).

Also (issue #18): a payment stuck in `PROCESSING` (process died between the two CAS steps) answers 409 forever — nothing reclaims it.

### 7. Trade-offs — markers in the same row are transactional with status changes; but publishing to Kafka and updating the marker are still two steps (publish ✔, mark ✘ → re-publish on retry, deduped by the deterministic event ID).
### 8. Performance — a few extra `UPDATE`s per payment.
### 9. Security — every re-run path must re-check ownership (it does: `processPayment` checks `customerId` first).
### 10. Operations — query `payments` where `status <> "publishedEventStatus"` or `status <> "orderSyncedStatus"` to find owed side effects.

### 11. Lab
[DS-03 Retry payment processing after a failure](labs/distributed-systems-labs.md#ds-03-retry-payment-processing-after-a-failure).

### 12. Verification
With order-service stopped, `process` fails; `payments` shows `publishedEventStatus = COMPLETED` but `orderSyncedStatus` NULL; after restarting order-service, a retry finishes the sync without publishing again.

### 13. Interview questions
- *Beginner:* What is a side effect?
- *Intermediate:* Why track each effect separately?
- *Advanced:* What is a fencing token and why does the lease need one?
- *Senior:* Replace markers with an outbox — what changes?

### 14. Senior discussion
Payment-service needed markers and leases precisely because it has no outbox. Is the outbox simpler overall, or does it just move the complexity to a relay?

---

## Chapter 7 — Exactly-once myths and the guarantees you actually have

### 1. Why this exists
Teams lose weeks chasing "exactly-once" when they need "effectively-once".

### 2. Core concept
- Exactly-once *delivery* over an unreliable network is impossible in general (the two generals problem).
- Exactly-once *processing* within one system is achievable with transactions.
- End-to-end effectively-once = at-least-once delivery + idempotent effects + deduplication records with sufficient retention.

### 3. Mental model
Guarantees are only as strong as the weakest hop.

### 4. Delivery Plus mapping — the real guarantee chain

| Hop | Guarantee | Weak spot |
| --- | --- | --- |
| App → order/payment | at-least-once with keys → effectively-once | order key reuse with a changed cart |
| DB write → Kafka publish | **at-most-once** (no outbox) | crash between commit and publish |
| Kafka → consumer | at-least-once | — |
| Consumer → effect | effectively-once (markers + CAS) | marker/effect not atomic (ms window) |
| Delivery → order/driver HTTP sync | effectively-once **if the client retries** | no repair without a retry (#98) |

### 5. Example — the weakest hop dominates: an `order.confirmed` lost between commit and publish produces *zero* notifications no matter how good the consumer is.
### 6. Failure scenario — see the table.
### 7. Trade-offs — closing each gap costs complexity; close the ones with business impact first (money > order status > notifications).
### 8. Performance — n/a.
### 9. Security — financial operations deserve the strongest chain (provider idempotency + DB constraints + reconciliation, [Book 25](25-payment-systems.md)).
### 10. Operations — reconciliation jobs (compare DB state with event history) are how mature systems catch the gaps they accept.

### 11. Lab
Build the table above yourself from the code before reading it; compare.

### 12. Verification
You can explain, for each hop, one concrete failure that violates "exactly once".

### 13. Interview questions
- *Beginner:* Can Kafka guarantee exactly-once delivery to your database?
- *Intermediate:* What is effectively-once?
- *Advanced:* Which hop in Delivery Plus is at-most-once and why?
- *Senior:* Prioritise closing these gaps with a fixed budget.

### 14. Senior discussion
Would a nightly reconciliation job (orders in DB vs events in Kafka) be a cheaper first step than an outbox?

---

## Chapter 8 — Failure simulations (do these)

Each simulation is a lab with exact commands. Do them in order; each builds intuition for the next.

| # | Scenario | What you will see | Lab |
| --- | --- | --- | --- |
| 1 | **Failed payment** | `simulateFailure: true` → payment `FAILED`, order `FAILED` (not CANCELLED), no delivery | [DS-08 Declined payment end to end](labs/distributed-systems-labs.md#ds-08-declined-payment-end-to-end), [case study 01](case-studies/01-failed-payment-race.md) |
| 2 | **Repeated payment event** | second `payment.completed` skipped by Redis marker; order unchanged | [DS-04](labs/distributed-systems-labs.md#ds-04-duplicate-payment-event) |
| 3 | **Duplicate order state transition** | two writers race to CONFIRMED; one publishes | [DS-05](labs/distributed-systems-labs.md#ds-05-concurrent-order-confirmation) |
| 4 | **Repeated delivery events** | repeated `complete` re-publishes the same `eventId`; consumers skip it | [DS-06](labs/distributed-systems-labs.md#ds-06-repeat-delivery-completion-with-a-service-down) |
| 5 | **Notification duplication** | rewind notification-service offsets → "already processed", no new rows; flush Redis first → duplicates appear | [KF-07](labs/kafka-labs.md#kf-07-redelivery-after-restart-is-skipped) |
| 6 | **Consumer restart mid-handler** | kill the consumer during a slow handler → lease expiry → re-processing | [DS-07](labs/distributed-systems-labs.md#ds-07-consumer-crash-mid-handler) |

---

[Library index](README.md) · Previous: [Book 07](07-kafka.md) · Next: [Book 09 — Distributed Systems](09-distributed-systems.md)
