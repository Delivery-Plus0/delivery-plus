# Book 07 — Kafka Fundamentals and Kafka in Delivery Plus

[Library index](README.md) · Previous: [Book 06](06-redis.md) · Next: [Book 08 — Idempotency & Distributed Operations](08-idempotency-and-distributed-operations.md)

**Level:** Intermediate → Advanced · **Prerequisites:** [Book 02 Ch. 3](02-data-structures-and-algorithms.md#chapter-3--queues-stacks-and-logs) (logs), [Book 04 Ch. 5–6](04-database-fundamentals.md#chapter-5--transactions-acid-and-isolation) (transactions, CAS).

Delivery Plus runs a single Kafka broker (`confluentinc/cp-kafka:7.6.1` with ZooKeeper, `docker-compose.base.yml`), three topics plus three dead-letter topics, and a shared producer/consumer built on **kafkajs** (`shared/src/kafka/`). This book teaches Kafka from first principles and then dissects every part of how this platform uses it.

**Tooling for every experiment** (from the `delivery-plus` root, dev stack running):
```bash
alias dc='docker compose -f docker-compose.base.yml -f docker-compose.dev.yml'
alias kt='dc exec kafka kafka-topics --bootstrap-server localhost:9092'
alias kcc='dc exec kafka kafka-console-consumer --bootstrap-server localhost:9092'
alias kcp='dc exec -T kafka kafka-console-producer --bootstrap-server localhost:9092'
alias kcg='dc exec kafka kafka-consumer-groups --bootstrap-server localhost:9092'
# Kafka UI: http://localhost:8085
```

**Labs:** [kafka-labs.md](labs/kafka-labs.md).

---

## Chapter 1 — Why event-driven architecture exists

### 1. Why this exists
When order-service confirms an order, several things should follow: a notification, later analytics, maybe a loyalty point. If order-service calls each of them over HTTP, it must know them all, wait for them all, and fail when any of them is down.

### 2. Core concept
- **Synchronous** (HTTP): caller waits; tight temporal coupling — both must be up *now*.
- **Asynchronous** (messages): caller publishes and moves on; consumers process when they can.
- **Command**: "do this" — addressed to one handler, may be rejected (`POST /api/deliveries/:id/assign`).
- **Event**: "this happened" — a fact in the past tense, published to whoever cares (`order.confirmed`). Cannot be rejected, only reacted to.

### 3. Mental model
```text
Synchronous chain (fragile):  order ──HTTP──► notification ──HTTP──► analytics
                               (order fails if notification is down)

Event fan-out (decoupled):     order ──► order.events ──┬──► notification-service
                                                        ├──► (future) analytics
                                                        └──► (future) loyalty
```

### 4. Delivery Plus mapping — **CURRENT**
Delivery Plus uses **both**, deliberately:
- Synchronous HTTP for things the caller must know *now*: payment-service tells order-service the result (`services/payment-service/src/common/order-service.client.ts`); delivery-service updates the order and frees the driver (`services/delivery-service/src/common/*.client.ts`).
- Kafka events for things that can happen *later* and for multiple readers: notifications, and order-service converging its status from payment and delivery events.

Both paths apply the same transitions; compare-and-set makes the second one a no-op ([Book 04 Ch. 6](04-database-fundamentals.md#chapter-6--concurrency-control-locks-cas-lost-updates-and-deadlocks)).

### 5. Example
`order.confirmed` → notification-service creates "Order Confirmed" (`services/notification-service/src/services/notifications.service.ts`). order-service doesn't know notification-service exists.

### 6. Failure scenario
"Events for everything": using Kafka for a request that needs an answer ("is this coupon valid?") turns a 5 ms HTTP call into request/response over topics, with correlation IDs, timeouts and two topics — for no benefit.

### 7. Trade-offs
| | HTTP | Events |
| --- | --- | --- |
| Caller needs the result | ✔ | ✘ |
| Many independent reactions | ✘ (fan-out code) | ✔ |
| Consumer down | caller fails | consumer catches up later |
| Debugging | one trace | distributed, needs IDs |
| Consistency | immediate | eventual |

### 8. Performance — events absorb bursts (consumers process at their own pace); HTTP propagates bursts downstream.
### 9. Security — events are broadcast to anyone with topic read access; treat topics as an API with access control (none locally).
### 10. Operations — asynchronous systems fail silently: a consumer that stops doesn't produce errors upstream, only *lag* ([Chapter 5](#chapter-5--consumer-groups-rebalancing-offsets-and-lag)).

### 11. Lab
[KF-01 Produce and consume by hand](labs/kafka-labs.md#kf-01-produce-and-consume-by-hand).

### 12. Verification
You see the real `order.created` … `order.delivered` events from `npm run e2e` in the console consumer, and you can say which service published each.

### 13. Interview questions
- *Beginner:* Command vs event?
- *Intermediate:* Why does Delivery Plus still use HTTP between payment and order services?
- *Advanced:* What new failure modes does event-driven design introduce?
- *Senior:* When would you *remove* Kafka from a design?

### 14. Senior discussion
Delivery status reaches order-service twice (HTTP + event). Is the event path still needed? What would have to be true to drop the HTTP path instead?

---

## Chapter 2 — The core model: broker, topic, partition, record, key, offset

### 1. Why this exists
Kafka's guarantees (ordering, replay, scaling) all follow from a few structural decisions.

### 2. Core concept
- **Broker**: a Kafka server. A **cluster** is several brokers.
- **Topic**: a named stream (`order.events`).
- **Partition**: a topic is split into partitions; each partition is an **ordered, append-only log** stored on a broker.
- **Record**: key (optional bytes), value (bytes), headers, timestamp.
- **Offset**: a record's position in its partition (0, 1, 2…). Unique *per partition* only.
- **Producer**: appends records. **Consumer**: reads records from a position.

### 3. Mental model
```text
Topic order.events
  Partition 0:  [0][1][2][3][4][5][6]  ← producers append here
                         ▲
                         └── consumer group "notification-service-group" is at offset 3
```

### 4. Delivery Plus mapping — **CURRENT**
- Topics (`shared/src/events/topics.ts`): `order.events`, `payment.events`, `delivery.events`, plus `order.events.dlq`, `payment.events.dlq`, `delivery.events.dlq` (created by consumers on subscribe, `ensureTopics` in `shared/src/kafka/kafka-consumer.service.ts`).
- Partitions: created with broker defaults → **1 partition**, replication factor **1** (single broker).
- Record value: JSON of a `BaseEvent` (`shared/src/events/base-event.ts`): `{ eventId, eventType, timestamp, correlationId, payload }`.
- Record key: the order ID (`eventPartitionKey` in `shared/src/events/event-identity.ts`).

### 5. Example
```bash
kt --describe --topic order.events
# Topic: order.events  PartitionCount: 1  ReplicationFactor: 1 …
kcc --topic order.events --from-beginning --property print.key=true --property print.offset=true --max-messages 5
```

### 6. Failure scenario
Assuming offsets are global: "offset 42" means nothing without the partition. Tools that store "last processed offset 42" across a topic with several partitions skip or duplicate data.

### 7. Trade-offs
More partitions = more parallelism, but more open files, longer leader elections, and ordering only within each partition.

### 8. Performance — Kafka's speed comes from sequential disk writes, batching, zero-copy reads and the OS page cache.
### 9. Security — a topic is readable by anyone who can connect to the broker unless ACLs are configured (not in this repo).
### 10. Operations — partition count is easy to increase, impossible to decrease, and increasing it changes which partition each key maps to.

### 11. Lab
[KF-03 Partitions and keys](labs/kafka-labs.md#kf-03-partitions-and-keys).

### 12. Verification
In a 3-partition test topic, all records with the same key land in the same partition; records without keys spread out.

### 13. Interview questions
- *Beginner:* Topic vs partition?
- *Intermediate:* Is ordering guaranteed across a topic?
- *Advanced:* What happens to key → partition mapping when you add partitions?
- *Senior:* How many partitions would you give `delivery.events`, and why?

### 14. Senior discussion
All three topics have one partition today. What is the first symptom that will force you to add partitions, and what must already be true in the code before you do (hint: keys and idempotency)?

---

## Chapter 3 — Replication, acknowledgements and durability

### 1. Why this exists
A broker's disk will fail. Kafka copies partitions to several brokers so that an acknowledged write survives.

### 2. Core concept
- Each partition has one **leader** (serves reads/writes) and **followers** (replicate).
- **ISR** (in-sync replicas): followers that are caught up.
- **Producer `acks`**: `0` (don't wait), `1` (leader wrote it), `all`/`-1` (all ISR wrote it).
- **`min.insync.replicas`**: with `acks=all`, how many replicas must have the write; if fewer are in sync, writes fail rather than silently becoming less durable.
- **Replication factor** (RF): number of copies. Typical production: RF=3, `min.insync.replicas=2`, `acks=all`.
- **Producer retries** can duplicate records; **idempotent producer** (`enable.idempotence`) adds sequence numbers so the broker drops duplicates *within one producer session*.

### 3. Mental model
`acks=all` + RF=3 + min ISR=2 = "an acknowledged write is on at least two disks".

### 4. Delivery Plus mapping
- **CURRENT:** one broker → RF 1. Any broker disk loss loses events. Fine for local development; not a production design.
- **CURRENT:** kafkajs producer created with defaults (`shared/src/kafka/kafka-producer.service.ts`): `acks` defaults to all replicas (`-1`), retries enabled, **idempotent producer off**.
- **CURRENT:** `KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1` in `docker-compose.base.yml` (required for a single broker).

### 5. Example
```text
RF=3, min.insync.replicas=2, acks=all
  broker A (leader) ✔   broker B ✔   broker C ✘ (down)   → write succeeds (2 in sync)
  broker A ✔            broker B ✘   broker C ✘          → write fails: NOT_ENOUGH_REPLICAS
```

### 6. Failure scenario
Producer sends, broker writes, the ack is lost on the network, the producer retries → the record is written twice. Without the idempotent producer (or consumer-side dedup), the consumer sees a duplicate. Delivery Plus relies on **consumer-side** dedup by `eventId` ([Book 08](08-idempotency-and-distributed-operations.md)).

### 7. Trade-offs
| Setting | Latency | Durability |
| --- | --- | --- |
| `acks=0` | lowest | can lose silently |
| `acks=1` | low | lose on leader failure before replication |
| `acks=all` + min ISR 2 | higher | survives one broker loss |

### 8. Performance — `acks=all` adds a replication round trip to every send; batching (`linger.ms`) amortises it.
### 9. Security — replication traffic between brokers should be encrypted in production.
### 10. Operations — alert on under-replicated partitions and shrinking ISR.

### 11. Lab
[KF-12 Producer acks and durability with one broker](labs/kafka-labs.md#kf-12-producer-acks-and-durability-with-one-broker).

### 12. Verification
You can explain why `min.insync.replicas=2` on the local single broker would make every `acks=all` write fail.

### 13. Interview questions
- *Beginner:* What is a replica?
- *Intermediate:* `acks=1` vs `acks=all`?
- *Advanced:* What does the idempotent producer guarantee, and what doesn't it?
- *Senior:* Production Kafka settings for payment events — justify each.

### 14. Senior discussion
Managed Kafka (MSK, Confluent Cloud) vs self-hosted for this team: what operational knowledge do you still need either way?

---

## Chapter 4 — Partition keys, ordering and hot partitions

### 1. Why this exists
The customer must never see "Delivered" and then "Picked up". Ordering matters — but only *per order*.

### 2. Core concept
- Kafka guarantees order **within a partition**.
- The **key** decides the partition: `partition = hash(key) mod partitions` (kafkajs v2's default partitioner uses murmur2 like the Java client).
- Same key → same partition → ordered relative to each other.
- **Hot partition**: one key (or a few) receive most traffic; one consumer becomes the bottleneck.

### 3. Mental model
Choose the key = "the entity whose events must stay in order". For Delivery Plus that is the **order**.

### 4. Delivery Plus mapping — **CURRENT**
- `eventPartitionKey(event)` returns `payload.orderId` (fallback: `correlationId`) and `KafkaProducerService.publish` uses it as the message key. Every order, payment and delivery event of one order lands in the same partition of its topic.
- Before this change, the key was a random per-event `correlationId`: no per-order ordering at all, hidden by the single partition. See [ADR 0004](adrs/0004-orderid-partition-key.md).
- Note: ordering across *topics* is not guaranteed — `payment.completed` (payment.events) and `order.confirmed` (order.events) are in different logs.

### 5. Example
```bash
kcc --topic delivery.events --from-beginning --property print.key=true --max-messages 10
# 8df4…  {"eventId":"…","eventType":"delivery.created", …}
# 8df4…  {"eventId":"…","eventType":"delivery.driver_assigned", …}   ← same key: the orderId
```

### 6. Failure scenario
Keying by `restaurantId` would order all events of one restaurant — and make a popular restaurant a hot partition during dinner rush, while other partitions sit idle.

### 7. Trade-offs
| Key | Ordering | Distribution |
| --- | --- | --- |
| orderId (current) | per order ✔ | excellent (many orders) |
| customerId | per customer | good |
| restaurantId | per restaurant | skewed (hot spots) |
| none | none | perfectly even |

### 8. Performance — throughput scales with partitions only if keys are well distributed.
### 9. Security — keys are visible metadata; an order ID is fine, a customer email would not be.
### 10. Operations — monitor per-partition lag to detect hot partitions.

### 11. Lab
[KF-11 Ordering per key](labs/kafka-labs.md#kf-11-ordering-per-key).

### 12. Verification
With 3 partitions and 2 consumers, events of the same key are always processed in order; events of different keys interleave.

### 13. Interview questions
- *Beginner:* What does the message key do?
- *Intermediate:* Why key by orderId instead of a random ID?
- *Advanced:* How do you handle a hot key?
- *Senior:* An event must be ordered relative to events in another topic. What are your options?

### 14. Senior discussion
Driver location events (future) belong to a driver, but customers care about them per order. Which key would you choose?

---

## Chapter 5 — Consumer groups, rebalancing, offsets and lag

### 1. Why this exists
You need several consumers to share work, and each needs to remember where it stopped.

### 2. Core concept
- **Consumer group**: consumers with the same `groupId` share a topic's partitions; each partition is read by **one** member at a time. Different groups each get *all* messages.
- **Rebalance**: when members join/leave/crash, partitions are reassigned (processing pauses).
- **Offset commit**: the group stores "next offset to read" per partition (in the `__consumer_offsets` topic).
- **Auto-commit** (periodic, independent of processing) vs **manual commit** (after processing).
- **Lag** = latest offset − committed offset: how far behind the group is.
- **Session timeout / heartbeats**: a member that stops heartbeating is removed (kafkajs default session timeout 30 s; heartbeats happen between messages).

### 3. Mental model
```text
order.events (1 partition)
   ├─ group notification-service-group → member A reads partition 0
   └─ group dlq-tool (only when you run npm run kafka:dlq) → reads order.events.dlq
Adding member B to notification-service-group → B idles (only 1 partition)
```

### 4. Delivery Plus mapping — **CURRENT**
- Groups: `order-service-group` (payment.events, delivery.events), `notification-service-group` (order.events, payment.events, delivery.events) — set in each `app.module.ts`.
- `autoCommit: false`; the shared consumer commits **one message at a time, after** handling, idempotency marking, or dead-lettering (`commitOffset` in `shared/src/kafka/kafka-consumer.service.ts`).
- `fromBeginning: false`: a brand-new group starts at the latest offset (it does not process history).
- No graceful shutdown hooks (issue #7): a stopped service stays in the group until the session times out; resetting offsets must wait until the group is `Empty`.

### 5. Example
```bash
kcg --describe --group notification-service-group
# TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# order.events    0          142             142             0
```

### 6. Failure scenario
A handler that takes 40 s (e.g. a slow HTTP call without a timeout) blocks heartbeats past the session timeout; the broker removes the consumer; the partition is reassigned; the message is processed *again* by the new owner while the old one finishes. Durable idempotency turns that into "in-progress → wait" instead of a duplicate side effect.

### 7. Trade-offs
| Commit strategy | Risk |
| --- | --- |
| Auto-commit | commit before processing → message lost on crash (at-most-once-ish) |
| Commit after processing (current) | crash before commit → redelivery (at-least-once) |
| Commit per message (current) | simple, slower at high throughput |
| Commit per batch | faster, larger redelivery window |

### 8. Performance — committing every message costs a broker round trip per message; at this scale that is fine; at 10k msg/s use batches.
### 9. Security — anyone who can join a group can steal partitions from your consumers (ACLs on group IDs in production).
### 10. Operations — **lag is the #1 Kafka health signal** ([case study 17](case-studies/17-consumer-lag.md)).

### 11. Lab
[KF-02 Consumer groups read independently](labs/kafka-labs.md#kf-02-consumer-groups-read-independently), [KF-04 Rebalance by adding a consumer](labs/kafka-labs.md#kf-04-rebalance-by-adding-a-consumer), [KF-05 Offsets and commits](labs/kafka-labs.md#kf-05-offsets-and-commits), [KF-06 Consumer lag](labs/kafka-labs.md#kf-06-consumer-lag).

### 12. Verification
You stop notification-service, place an order, and watch `LAG` become > 0; start it again and watch lag return to 0 and the notification appear.

### 13. Interview questions
- *Beginner:* What is a consumer group?
- *Intermediate:* Why can't two members of one group read the same partition?
- *Advanced:* What causes rebalance storms?
- *Senior:* Design lag alerting for order-service (thresholds, duration, what to do).

### 14. Senior discussion
With one partition per topic, scaling notification-service to 3 replicas gives zero extra throughput. When do you add partitions vs make the handler faster?

---

## Chapter 6 — Delivery semantics: at-most-once, at-least-once, "exactly-once"

### 1. Why this exists
"Did the notification get created once?" depends on choices made in the producer, the broker and the consumer together.

### 2. Core concept
- **At-most-once**: commit, then process. Crash → message lost.
- **At-least-once**: process, then commit. Crash → message redelivered (duplicate).
- **Exactly-once** in Kafka: idempotent producer + transactions, for *Kafka-to-Kafka* pipelines (read-process-write within Kafka). It does **not** cover side effects in PostgreSQL, HTTP calls or emails.
- **Effectively-once**: at-least-once delivery + idempotent processing.

### 3. Mental model
> **Beginner:** "Kafka delivers exactly once."
> **Reality:** Kafka delivers at least once to *your code* unless your side effects are inside Kafka.
> **Production issue:** a consumer restart after the DB insert but before the offset commit re-inserts the notification.
> **Senior concern:** where is the "already done" record, is it updated atomically with the side effect, and how long is it kept?

### 4. Delivery Plus mapping — **CURRENT: at-least-once + consumer dedup**
1. Publish happens *after* the database write (no outbox) — a crash in between loses the event (**PARTIAL**, issue #98).
2. Consumers commit after processing → redelivery is possible.
3. Deterministic `eventId`s + Redis markers per consumer group skip redeliveries and re-publishes.
4. Business-level idempotency (CAS on statuses, "same status → no-op") makes most handlers safe even without markers.

### 5. Example — the remaining gap
```text
notification handler: INSERT notification  ✔ (PostgreSQL commit)
                      markProcessed(eventId) ✘ (process killed here)
restart → redelivery → claim: lease expired → acquired → INSERT again  → duplicate notification
```
The window is milliseconds, but it exists because the marker (Redis) and the side effect (PostgreSQL) are not in one transaction. Fix options in [Book 27](27-advanced-data-patterns.md) (inbox table) — **FUTURE**.

### 6. Failure scenario — see the example and [case study 06](case-studies/06-in-memory-idempotency.md).
### 7. Trade-offs — Kafka transactions add latency and complexity and still don't cover external side effects; most systems choose at-least-once + idempotent consumers.
### 8. Performance — idempotency checks add one Redis round trip per event.
### 9. Security — duplicate payment side effects are financial risk; payment-service guards them in PostgreSQL (status markers and leases), not only in Kafka.
### 10. Operations — measure duplicates: count "already processed" log lines per consumer.

### 11. Lab
[KF-07 Redelivery after restart is skipped](labs/kafka-labs.md#kf-07-redelivery-after-restart-is-skipped).

### 12. Verification
Rewound offsets produce "already processed" logs and zero new notification rows.

### 13. Interview questions
- *Beginner:* At-most-once vs at-least-once?
- *Intermediate:* Why doesn't Kafka's exactly-once cover a database insert?
- *Advanced:* Where exactly is the duplicate window in the current notification consumer?
- *Senior:* Would you implement an inbox table for notification-service? Why or why not?

### 14. Senior discussion
"Exactly-once" is often a marketing term. How would you explain the real guarantee of Delivery Plus to a product manager in two sentences?

---

## Chapter 7 — Retries, poison messages, dead-letter topics and replay

### 1. Why this exists
Some messages fail temporarily (DB blip), some fail forever (malformed JSON, a bug). Retrying forever blocks the partition; giving up silently loses data.

### 2. Core concept
- **Retry with backoff** for transient errors.
- **Poison message**: one that will never succeed; it blocks everything behind it in the partition.
- **Dead-letter topic (DLQ)**: where messages go after retries are exhausted, with metadata explaining why.
- **Replay**: republish dead-lettered messages once the cause is fixed.

### 3. Mental model
```text
message ─► parse? ──no──► DLQ (reason: unparseable) ─► commit
            │yes
            ▼
        handler? ──no──► commit (not ours)
            │yes
            ▼
        claim (Redis) ─ processed ─► commit
            │acquired
            ▼
        handler ×3 (200 ms, 400 ms) ─ success ─► mark processed ─► commit
            │fail
            ▼
        DLQ (reason: handler-failed, error) ─► release claim ─► commit
```

### 4. Delivery Plus mapping — **CURRENT**
- `handleMessage` in `shared/src/kafka/kafka-consumer.service.ts` implements exactly the diagram above. `maxHandlerAttempts` is configurable (`KafkaModule.register`), default 3.
- DLQ topics are `<topic>.dlq`; dead-lettered records keep key, value and original headers and add `dlq-original-topic`, `dlq-original-partition`, `dlq-original-offset`, `dlq-consumer-group`, `dlq-reason`, `dlq-error`, `dlq-failed-at` (`DEAD_LETTER_HEADERS`).
- If the dead-letter send itself fails, the offset is **not** committed — kafkajs redelivers.
- Replay tool: `npm run kafka:dlq -- order.events` (list) and `-- --replay` (republish to the original topic, `dlq-*` headers stripped), tracked by the `delivery-plus-dlq-replay` group (`scripts/kafka-dlq.ts`).
- Replay is safe because every group that already handled the event skips it via its idempotency marker; only the group that failed runs it.
- See [case study 07](case-studies/07-dlq-implementation.md) and [case study 16](case-studies/16-kafka-replay.md).

### 5. Example
```bash
echo "not json at all" | kcp --topic order.events
npm run kafka:dlq -- order.events
# order.events.dlq: 1 message(s) pending …  reason=unparseable
```

### 6. Failure scenario
A handler that fails because of a *bug* will fail identically on replay. Replay is for fixed causes (a DB that was down, a deployed fix), not a retry button.

### 7. Trade-offs
| Approach | Pro | Con |
| --- | --- | --- |
| Retry in-process (current) | simple, keeps order | blocks the partition while retrying |
| Retry topics (`.retry.5m`) | non-blocking, delayed retries | loses per-key order |
| DLQ + manual replay (current) | nothing lost | needs an operator |
| Skip and log | nothing blocks | data loss |

### 8. Performance — 3 attempts with 200 ms + 400 ms backoff ≈ 0.6 s added before a dead letter; the partition is blocked meanwhile.
### 9. Security — DLQ topics contain full payloads; protect them like the source topics; the `dlq-error` header must not contain secrets.
### 10. Operations — alert when any `.dlq` topic grows; a growing DLQ is a silent data-loss risk until replayed.

### 11. Lab
[KF-09 Poison message to the DLQ](labs/kafka-labs.md#kf-09-poison-message-to-the-dlq), [KF-10 Handler failure, DLQ and replay](labs/kafka-labs.md#kf-10-handler-failure-dlq-and-replay).

### 12. Verification
A forced handler failure ends in the DLQ with the error header; after the fix, replay creates the notification exactly once; a second replay finds nothing pending.

### 13. Interview questions
- *Beginner:* What is a dead-letter queue?
- *Intermediate:* Why not retry forever?
- *Advanced:* Why does replay need consumer idempotency?
- *Senior:* Design DLQ alerting and an operator runbook.

### 14. Senior discussion
In-process retries block the partition, preserving order but delaying every later event of every order. Would you accept out-of-order processing (retry topics) for notifications? For order status?

---

## Chapter 8 — Retention, compaction and replay

### 1. Why this exists
A log can't grow forever, but deleting too early prevents replay and recovery.

### 2. Core concept
- **Time/size retention** (`retention.ms`, default 7 days): old segments are deleted.
- **Log compaction** (`cleanup.policy=compact`): keep only the latest record per key — a table of "current value per key".
- **Replay**: reset a group's offsets (`--to-earliest`, `--to-datetime`, `--shift-by`) and re-read.

### 3. Mental model
Delete-retention topics are *history for a while*; compacted topics are *the latest state forever*.

### 4. Delivery Plus mapping
- **CURRENT:** broker defaults → delete retention 7 days. The Redis processed-marker retention (7 days) was chosen to match.
- **NOT USED:** compaction.
- **FUTURE:** a compacted `driver.status` or `delivery.state` topic could give new services the current state of every delivery without calling delivery-service.

### 5. Example
```bash
kcg --group notification-service-group --reset-offsets --to-datetime 2026-10-01T00:00:00.000 --all-topics --execute
# (service stopped and group Empty first)
```

### 6. Failure scenario
Replaying 7 days of `order.events` into a consumer whose idempotency markers were lost (Redis flushed) re-sends every "Order Confirmed" notification for a week.

### 7. Trade-offs — longer retention = more replay power and more disk; compaction = cheap current state but no history.
### 8. Performance — consumers replaying from disk (not page cache) read slower and may affect the broker.
### 9. Security — retention is also a privacy setting; events older than retention are gone (useful for deletion requests, bad for audits).
### 10. Operations — document who may reset offsets in production and how.

### 11. Lab
[KF-08 Replay by rewinding offsets](labs/kafka-labs.md#kf-08-replay-by-rewinding-offsets).

### 12. Verification
After a rewind, redelivered events are skipped by idempotency; after `FLUSHDB` on Redis and another rewind, you see duplicates — and understand why the markers matter.

### 13. Interview questions
- *Beginner:* What is retention?
- *Intermediate:* What is log compaction for?
- *Advanced:* How do you safely replay events into a single consumer group?
- *Senior:* Could Delivery Plus rebuild notification-service's database from Kafka? What's missing?

### 14. Senior discussion
Should business-critical events (payments) be kept far longer than 7 days, or should a database be the long-term record and Kafka only the transport?

---

## Chapter 9 — Event envelopes, contracts, versioning and schema evolution

### 1. Why this exists
Producers and consumers deploy independently. A payload change that breaks a consumer is an outage that no compiler catches.

### 2. Core concept
- **Envelope**: metadata common to every event (ID, type, time, correlation, version, source).
- **Contract**: the agreed payload shape per event type.
- **Compatibility**: *backward* (new consumers read old events), *forward* (old consumers read new events). Safe changes: add optional fields. Unsafe: remove/rename fields, change types or meaning.
- **Schema registry** (Avro/Protobuf/JSON Schema): validates and versions schemas centrally.

### 3. Mental model
An event schema is a public API with unknown consumers and no rollback.

### 4. Delivery Plus mapping
- **CURRENT:** envelope `BaseEvent { eventId, eventType, timestamp, correlationId, payload }` (`shared/src/events/base-event.ts`); payload types `OrderPayload`, `PaymentPayload`, `DeliveryPayload` in `shared/src/events/*-events.ts`. TypeScript types only — **no runtime validation** beyond the consumer checking `eventId`/`eventType` (unparseable → DLQ).
- **CURRENT:** no `version` field; compatibility relies on additive changes.
- **PLANNED/FUTURE:** issue #23 (versioned contract registry + runtime validation); issue #5 needs `customerId` added to payment and delivery payloads — an additive, backward-compatible change.

### 5. Example
```ts
// additive change (safe): add customerId to DeliveryPayload
export interface DeliveryPayload {
  deliveryId: string; orderId: string; driverId?: string; status: string;
  customerId?: string;   // new, optional: old consumers ignore it, new consumers must handle its absence in old events
}
```

### 6. Failure scenario
Renaming `orderId` to `order_id` in `PaymentPayload`: order-service's `syncStatusFromEvent(event.payload.orderId, …)` receives `undefined`, logs "Ignoring event for unknown order", and payments silently stop confirming orders — while every test of payment-service passes.

### 7. Trade-offs — shared TypeScript types (current) give compile-time safety inside the monorepo but nothing at runtime and nothing for consumers in other languages; a schema registry adds tooling and a deployment dependency.
### 8. Performance — JSON is verbose; Avro/Protobuf are smaller and faster to parse.
### 9. Security — validation at the consumer boundary also blocks malicious or malformed events from reaching handlers.
### 10. Operations — keep a catalog of events and their consumers (this book's last chapter is one).

### 11. Lab
[KF-13 Event contract change](labs/kafka-labs.md#kf-13-event-contract-change).

### 12. Verification
You show an incompatible rename silently breaking order confirmation in a local branch, and an additive change working with old and new events.

### 13. Interview questions
- *Beginner:* What is an event envelope?
- *Intermediate:* Backward vs forward compatibility?
- *Advanced:* How do you remove a field from an event safely?
- *Senior:* Schema registry or shared types for this monorepo?

### 14. Senior discussion
`eventType` values are strings like `order.confirmed`. Should the version be in the type (`order.confirmed.v2`), in the envelope, or in the topic name?

---

## Chapter 10 — Observability and operational failures

### 1. Why this exists
Kafka problems rarely throw errors in the producer; they show up as delay, duplicates or silence.

### 2. Core concept
Key signals: consumer lag per group/partition, DLQ size, handler duration, retry count, rebalance count, produce errors, under-replicated partitions, broker disk.

### 3. Mental model
```text
Producer errors  → "we couldn't tell anyone"        (data loss risk without outbox)
Lag growing      → "nobody is listening fast enough" (stale notifications/status)
DLQ growing      → "we listened and failed"          (needs replay)
Rebalances       → "consumers keep dying/joining"    (duplicate risk, pauses)
```

### 4. Delivery Plus mapping
- **CURRENT:** structured logs from `KafkaConsumerService` (attempts, dead-lettering, "already processed", the startup warning when durable idempotency is off); Kafka UI on `:8085`; `kafka-consumer-groups` CLI; `npm run kafka:dlq`.
- **CURRENT, expected noise:** kafkajs logs `Topic creation errors` at ERROR on consumer start when topics already exist — harmless.
- **NOT IMPLEMENTED:** metrics, lag alerts, tracing across events (issue #15, [Book 20](20-observability.md)). `correlationId` in events is generated per event, not propagated from the HTTP request.

### 5. Example — "notifications are late" runbook
1. `kcg --describe --group notification-service-group` → lag?
2. `dc logs notification-service --since 10m | grep -E "attempt|dead-letter"` → failing?
3. `npm run kafka:dlq -- order.events` → dead letters?
4. `dc ps notification-service` → restarting?

### 6. Failure scenario
Broker restart: producers get errors. order-service has already committed the order to PostgreSQL (and cleared the cart) when the publish throws. Without an `Idempotency-Key` the request returns 500 although the order exists; with one, the `catch` in `createFromCart` finds the saved order by its key and returns it as a success. Either way, no `order.created` event will ever be sent (no outbox).

### 7. Trade-offs — Kafka UI is convenient but is itself an unauthenticated admin console; never expose it publicly.
### 8. Performance — measure handler p95 per event type.
### 9. Security — Kafka UI and the broker port (`127.0.0.1:9092` in dev) must not be internet-reachable.
### 10. Operations — runbooks in `docs/runbooks/local-stack-troubleshooting.md` and `docs/deployment.md` (topics, DLQ, replay, retention).

### 11. Lab
[KF-06 Consumer lag](labs/kafka-labs.md#kf-06-consumer-lag) and [OPS-04 Kafka outage during checkout](labs/devops-labs.md#ops-04-kafka-outage-during-checkout).

### 12. Verification
You can explain, from logs and the database alone, which orders were created while Kafka was down and which events are missing.

### 13. Interview questions
- *Beginner:* What is consumer lag?
- *Intermediate:* How do you detect a stuck consumer?
- *Advanced:* What does a high rebalance rate indicate?
- *Senior:* Which three Kafka alerts would you create first, with thresholds?

### 14. Senior discussion
If Kafka is down, should checkout fail (consistency) or succeed and reconcile later (availability)? What does the outbox change about that question?

---

## Chapter 11 — Kafka in Delivery Plus (complete reference)

### 11.1 Topology — **CURRENT**

```text
                         order.events (key = orderId)
order-service ───────────────────────────────────────────► notification-service  (order.confirmed → "Order Confirmed")
     ▲   ▲
     │   │ payment.events (key = orderId)
     │   └────────────────── payment-service ────────────► notification-service  (payment.completed → no-op today)
     │
     │ delivery.events (key = orderId)
     └────────────────────── delivery-service ───────────► notification-service  (delivery.driver_assigned → no-op today)

order-service consumes: payment.created / completed / failed, delivery.driver_assigned / picked_up / completed
driver-service: no Kafka (availability is set synchronously by delivery-service)
Each source topic has <topic>.dlq.
```

### 11.2 Event catalogue

| Topic | Event types | Producer | Payload | Consumers (group) |
| --- | --- | --- | --- | --- |
| `order.events` | `order.created`, `order.payment_pending`, `order.confirmed`, `order.failed`, `order.cancelled`, `order.preparing`, `order.ready_for_pickup`, `order.driver_assigned`, `order.picked_up`, `order.delivered` | order-service (`createFromCart`, `updateStatus`) | `{ orderId, customerId, restaurantId, total, status }` | notification-service (`order.confirmed`) |
| `payment.events` | `payment.created`, `payment.completed`, `payment.failed` | payment-service (status markers, deterministic `paymentEventId`) | `{ paymentId, orderId, amount, status }` | order-service (all three), notification-service (`completed`, no-op) |
| `delivery.events` | `delivery.created`, `driver_assigned`, `picked_up`, `in_transit`, `completed`, `cancelled` | delivery-service (after HTTP syncs) | `{ deliveryId, orderId, driverId?, status }` | order-service (`driver_assigned`, `picked_up`, `completed`), notification-service (`driver_assigned`, no-op) |

Note: `order.ready_for_pickup` is consumed by delivery-service's automatic dispatch (issue #97, consumer group `delivery-service-group`, durable idempotency). The handler never dead-letters just because no driver is free; the delivery waits and a sweep retries it.

### 11.3 Event IDs — **CURRENT**
- Order and delivery events: `lifecycleEventId(entityId, eventType)` (UUID v5, `shared/src/events/event-identity.ts`).
- Payment events: `paymentEventId(paymentId, eventType)` (UUID v5, own namespace, `services/payment-service/src/services/payments.service.ts`).
- Same entity + same type → same ID → a re-publish is recognised as a duplicate.

### 11.4 Idempotency — **CURRENT**
- order-service and notification-service: durable, per group, Redis (`kafka:idempotency:{group}:{eventId}`), lease 60 s, processed retention 7 days.
- Business idempotency underneath: order-service applies payment and delivery events through `syncStatusFromEvent` (same status → no-op; stale → logged and skipped), so even a duplicate that slipped through would not change state twice.

### 11.5 DLQ and replay — **CURRENT** — see Chapter 7, [case studies 07](case-studies/07-dlq-implementation.md) and [16](case-studies/16-kafka-replay.md).

### 11.6 Delivery lifecycle through Kafka — **CURRENT**
```text
POST /api/deliveries            → delivery.created
POST /api/deliveries/:id/assign → (driver BUSY via HTTP, order DRIVER_ASSIGNED via HTTP) → delivery.driver_assigned
POST …/pickup                   → (order PICKED_UP via HTTP) → delivery.picked_up
POST …/start                    → (order caught up to PICKED_UP if needed) → delivery.in_transit
POST …/complete                 → (driver freed, order DELIVERED via HTTP) → delivery.completed
order-service consumer: applies the same statuses again → no-op thanks to CAS
```
Delivery actions are retry-safe: repeating an action on a delivery already in that state re-runs the HTTP syncs and re-publishes with the same `eventId` ([case study 08](case-studies/08-delivery-lifecycle-events.md)).

### 11.7 Current limitations
| Limitation | Status | Tracking |
| --- | --- | --- |
| Publish after DB write, no outbox → event lost on crash | **PARTIAL** | #98, [case study 13](case-studies/13-transactional-outbox.md) |
| Payment/delivery payloads lack `customerId` → no payment/delivery notifications | **PARTIAL** | #5 |
| Redis marker not transactional with the side effect → tiny duplicate window | **PARTIAL** | [Book 27](27-advanced-data-patterns.md) |
| No schema versioning / runtime validation | **PLANNED** | #23 |
| No graceful shutdown → slow group exit | **PLANNED** | #7 |
| Single broker, RF 1, 1 partition per topic | dev only | [Book 19](19-kubernetes.md), [Book 26](26-reliability-engineering.md) |
| `correlationId` not propagated from HTTP request into events | **PARTIAL** | [Book 20](20-observability.md) |

### 11.8 The outbox problem in one picture
```text
TODAY                                       WITH OUTBOX (PLANNED)
BEGIN; UPDATE orders …; COMMIT;  ✔          BEGIN;
publish(order.confirmed)        ✘ crash       UPDATE orders …;
→ order confirmed, no event, forever          INSERT INTO outbox(event) …;
                                            COMMIT;            ← both or neither
                                            relay: read outbox → publish → mark sent
                                            (crash → relay retries; eventId dedups)
```
Full design: [Book 27](27-advanced-data-patterns.md), [ADR 0010](adrs/0010-transactional-outbox.md).

### 11.9 Lab
[KF-14 Delivery lifecycle trace](labs/kafka-labs.md#kf-14-delivery-lifecycle-trace) — follow one order through all three topics and both consumer groups.

---

[Library index](README.md) · Previous: [Book 06](06-redis.md) · Next: [Book 08 — Idempotency & Distributed Operations](08-idempotency-and-distributed-operations.md)
