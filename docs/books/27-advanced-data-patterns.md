# Book 27 — Advanced Database & Distributed Data Patterns

[Library index](README.md) · Previous: [Book 26](26-reliability-engineering.md) · Next: [Book 28 — Software Architecture & Evolution](28-architecture-evolution.md)

**Level:** Advanced → Senior · **Prerequisites:** [Book 04](04-database-fundamentals.md), [Book 07](07-kafka.md), [Book 08](08-idempotency-and-distributed-operations.md), [Book 09](09-distributed-systems.md).

| Pattern | Status in Delivery Plus |
| --- | --- |
| Denormalized snapshots (order items, payment `customerId`) | **CURRENT** |
| Per-row side-effect markers (payments) — an "outbox-lite" | **CURRENT** |
| Consumer dedup in Redis (an "inbox-lite") | **CURRENT** |
| Choreographed saga for order status (payment/delivery events) | **CURRENT** (partial: no compensation) |
| Transactional outbox | **PLANNED** (#98) |
| Inbox table (transactional dedup) | **FUTURE** |
| Compensating saga for cancellation/refund | **PLANNED** (#53) |
| CQRS read models / materialized views | **FUTURE** |
| CDC (Debezium) | **FUTURE / optional** |
| Event sourcing | **NOT USED** (and not recommended here — Chapter 6) |

---

## Chapter 1 — Transactional outbox

### 1. Why this exists
"Commit to PostgreSQL, then publish to Kafka" can't be atomic. A crash in between loses the event; reversing the order publishes events for changes that never committed.

### 2. Core concept
Write the event into an `outbox` table **in the same transaction** as the state change. A relay reads unsent rows, publishes them, and marks them sent. Delivery is at-least-once; consumers dedup by `eventId` (already in place).

### 3. Mental model
```text
DB transaction
 ├── update state
 └── write outbox event
        ↓
      relay (poll every 100–500 ms, or CDC)
        ↓
      Kafka ──► consumers (dedup by eventId)
```

### 4. Delivery Plus mapping — **PLANNED (#98)**
Today: `OrdersService.updateStatus` does `orders.updateStatus` (CAS) then `kafkaProducer.publish`; `DeliveriesService` does `transition` then HTTP syncs then `publishEvent`. Payment-service emulates an outbox per row with `publishedEventStatus`.

### 5. Example — a design for order-service (FUTURE)
```sql
CREATE TABLE outbox (
  id uuid PRIMARY KEY,                 -- = eventId (lifecycleEventId), so duplicates are impossible
  topic text NOT NULL,
  key text NOT NULL,                   -- orderId (partition key)
  payload jsonb NOT NULL,              -- the BaseEvent
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "sentAt" timestamptz
);
CREATE INDEX idx_outbox_unsent ON outbox ("createdAt") WHERE "sentAt" IS NULL;
```
```ts
// inside one TypeORM transaction
await manager.update(Order, { id, status: from }, { status: to });           // CAS
await manager.insert(Outbox, { id: lifecycleEventId(id, type), topic: TOPICS.ORDER_EVENTS, key: id, payload: event });
// relay (separate loop or process)
const rows = await select unsent ordered by createdAt limit 100 for update skip locked;
for (const r of rows) { await producer.send(r.topic, [{ key: r.key, value: JSON.stringify(r.payload) }]); mark sent; }
```
`FOR UPDATE SKIP LOCKED` lets several relay instances share work without double-sending (mostly — sends can still repeat after a crash, which `eventId` dedup absorbs).

### 6. Failure scenario — relay sends, crashes before `sentAt` → re-sends on restart → consumers skip it by `eventId`. Ordering per order holds only if the relay sends rows of one key in `createdAt` order (one relay per partition key range, or ordered selection).
### 7. Trade-offs — polling relay: simple, adds latency and DB load; CDC: near real-time, extra infrastructure; payment-style markers: no new table, but only for effects that map 1:1 to row status.
### 8. Performance — one extra insert per state change; relay polling cost; cleanup job (`DELETE … WHERE "sentAt" < now() - interval '7 days'`).
### 9. Security — outbox rows contain event payloads (customer IDs); same protection as the main tables.
### 10. Operations — metric: oldest unsent outbox row age (like consumer lag).

### 11. Lab — [DS-11 Outbox simulation](labs/distributed-systems-labs.md#ds-11-outbox-simulation).
### 12. Verification — killing the process between commit and publish loses nothing.

### 13. Interview questions
- *Intermediate:* What problem does the outbox solve?
- *Advanced:* How do you keep per-key ordering with several relay instances?
- *Senior:* Roll out an outbox in order-service while the old direct-publish code is live.

### 14. Senior discussion
Should delivery-service's HTTP syncs to order- and driver-service also move behind the outbox (become event-driven), closing the "client never retries" gap? What would you lose?

---

## Chapter 2 — Inbox and idempotent projections

### 1. Why this exists
Redis dedup markers are not transactional with the consumer's database writes (Book 08 Ch. 5).

### 2. Core concept — **inbox table**: `INSERT INTO inbox(group, eventId)` in the same transaction as the side effect; a unique violation means "already processed". **Idempotent projection**: the effect itself is naturally idempotent (upsert by key, unique `eventId` column).
### 3. Mental model — make "remember I did it" and "do it" one atomic write.
### 4. Delivery Plus mapping — **CURRENT** Redis markers; **FUTURE** inbox for notification-service (`notifications` could carry `sourceEventId` with a unique index).
### 5. Example
```sql
BEGIN;
INSERT INTO processed_events ("consumerGroup", "eventId") VALUES ('notification-service-group', $1);  -- fails if duplicate
INSERT INTO notifications (...) VALUES (...);
COMMIT;
```
### 6. Failure scenario — inbox without retention: the table grows forever; prune by age beyond Kafka retention.
### 7. Trade-offs — inbox = strongest guarantee, DB write per event; Redis = fast, tiny window.
### 8. Performance — one extra insert per event; index on (group, eventId).
### 9. Security — n/a.
### 10. Operations — the inbox doubles as an audit of what was processed.

### 11. Lab — implement the inbox in a scratch branch for notification-service and re-run [KF-07](labs/kafka-labs.md#kf-07-redelivery-after-restart-is-skipped) with Redis flushed.
### 12. Verification — no duplicates even after flushing Redis.

### 13. Interview questions
- *Advanced:* Inbox vs Redis dedup?
- *Senior:* When is a natural idempotency key better than an inbox?

### 14. Senior discussion
Would you keep Redis markers *and* add an inbox, or replace one with the other?

---

## Chapter 3 — Sagas and consistency boundaries

### 1. Why this exists
Business operations span services; there is no global transaction.

### 2. Core concept — a **consistency boundary** is what one transaction can protect (one service's database). Across boundaries: sagas with compensations, idempotent steps, explicit intermediate states ("CANCELLATION_PENDING").
### 3. Mental model — draw the boundary first, then design what happens at each crossing.
### 4. Delivery Plus mapping — order lifecycle is a choreographed saga across order, payment and delivery services (**CURRENT**); cancellation/refund compensation is missing (**PLANNED** #53). See [Book 09 Ch. 5](09-distributed-systems.md#chapter-5--distributed-transactions-2pc-and-sagas).
### 5. Example — cancellation saga states (FUTURE): `CANCELLATION_REQUESTED → (refund if paid) → (cancel delivery, free driver if active) → CANCELLED`, each step idempotent, each publishing an event.
### 6. Failure scenario — compensation fails (refund API down): the saga must stay in a visible pending state and retry, not claim success.
### 7. Trade-offs — more intermediate states = more UI and API surface, more correctness.
### 8. Performance — sagas take seconds to minutes; UIs must show progress.
### 9. Security — compensations are privileged actions.
### 10. Operations — saga instances need a queryable state and timeouts.

### 11. Lab — [DS-10 Saga simulation: cancel a paid order](labs/distributed-systems-labs.md#ds-10-saga-simulation-cancel-a-paid-order).
### 12. Verification — your saga handles "refund fails" without losing the cancellation.

### 13. Interview questions
- *Senior:* Choreography or orchestration for cancellation? Who owns the saga state?

### 14. Senior discussion
Should the order state machine gain intermediate cancellation states, or should the saga's progress live elsewhere?

---

## Chapter 4 — Change data capture (CDC)

### 1. Why this exists
Turn database changes into events without application code changes.
### 2. Core concept — read PostgreSQL's WAL via logical replication (Debezium/Kafka Connect); stream row changes or outbox rows to Kafka.
### 3. Mental model — the database's own log becomes your event source.
### 4. Delivery Plus mapping — **FUTURE / optional**: the cleanest use is CDC on the outbox table (outbox pattern + CDC relay). CDC on business tables leaks internal schema to consumers.
### 5. Example — Debezium outbox event router: reads `outbox` inserts, routes by `topic`, keys by `key`.
### 6. Failure scenario — replication slot not consumed (connector down) → PostgreSQL retains WAL indefinitely → disk full.
### 7. Trade-offs — CDC: low latency, no relay code, new infrastructure and operational skills.
### 8. Performance — logical decoding adds load on the primary.
### 9. Security — CDC credentials can read everything replicated; restrict publications.
### 10. Operations — monitor replication slot lag and retained WAL.

### 11. Lab — thought lab: list what Delivery Plus would need to run Debezium (Kafka Connect, `wal_level=logical`, replication slot, publication).
### 12. Verification — your list includes WAL retention risk.

### 13. Interview questions
- *Advanced:* CDC on business tables vs on an outbox?
- *Senior:* Polling relay or CDC for this team?

### 14. Senior discussion
When does CDC become worth its operational cost?

---

## Chapter 5 — CQRS, read models and materialized views

### 1. Why this exists
Screens that need data from several services (or heavy aggregations) are slow or impossible with live queries.

### 2. Core concept — **CQRS**: separate the write model (commands, invariants) from read models (queries, denormalized views) updated from events. **Materialized view**: a stored query result refreshed periodically.
### 3. Mental model — read models are caches you can rebuild from events.
### 4. Delivery Plus mapping — **FUTURE**: restaurant dashboard "today's orders with delivery status" (order + delivery events); admin "stuck orders" view; customer "order + delivery" in one call. Within one database, a PostgreSQL materialized view can serve aggregates (orders per hour per restaurant).
### 5. Example — read model fed by events: `order.*` and `delivery.*` → `restaurant_order_board(orderId PK, status, deliveryStatus, updatedAt)` upserted by `orderId`; handlers idempotent by upsert + version/timestamp guard.
### 6. Failure scenario — projection applies `delivery.picked_up` before `order.ready_for_pickup` (different topics) → status regresses. Guard with lifecycle order (only move forward along the path, as `syncOrderAlongDelivery` does).
### 7. Trade-offs — eventual consistency in exchange for fast, decoupled reads; rebuild procedures required.
### 8. Performance — reads become single-table lookups.
### 9. Security — read models often combine data from several owners; authorize at query time.
### 10. Operations — rebuilds need replay (Kafka retention) or snapshots.

### 11. Lab — design the restaurant board projection and its rebuild procedure.
### 12. Verification — your projection is correct under duplicates, reordering across topics and replay.

### 13. Interview questions
- *Intermediate:* What is CQRS?
- *Advanced:* How do you make projections idempotent and order-tolerant?
- *Senior:* When is CQRS over-engineering?

### 14. Senior discussion
Is a read model in a new service better than a materialized view in order-service's database for the restaurant dashboard?

---

## Chapter 6 — Event sourcing (and why it's not used here)

### 1. Why this exists
Some domains need a complete, replayable history as the source of truth.
### 2. Core concept — store events as the primary record; derive current state by folding events; snapshots for speed; projections for queries.
### 3. Mental model — the ledger *is* the database.
### 4. Delivery Plus mapping — **NOT USED**. Services store current state; events are integration messages with 7-day retention. Kafka here is a transport, not an event store.
### 5. Example — a payment ledger (Book 25 Ch. 4) is a narrow, useful slice of event-sourcing thinking without adopting it everywhere.
### 6. Failure scenario — adopting event sourcing system-wide for a CRUD-heavy domain: schema evolution of years of events, complex projections, slow onboarding — high cost, low benefit.
### 7. Trade-offs — full audit and temporal queries vs significant complexity.
### 8. Performance — reads need projections; writes are appends.
### 9. Security — erasing personal data from an immutable log needs crypto-shredding or similar.
### 10. Operations — event store retention is forever.

### 11. Lab — list which Delivery Plus aggregate (if any) would benefit from event sourcing, and argue against it.
### 12. Verification — you can state the cost that outweighs the benefit for orders.

### 13. Interview questions
- *Advanced:* Event sourcing vs event-driven architecture?
- *Senior:* When would you choose event sourcing?

### 14. Senior discussion
Payments are the strongest candidate for an event-sourced (ledger) model. Is a ledger table enough?

---

[Library index](README.md) · Previous: [Book 26](26-reliability-engineering.md) · Next: [Book 28 — Software Architecture & Evolution](28-architecture-evolution.md)
