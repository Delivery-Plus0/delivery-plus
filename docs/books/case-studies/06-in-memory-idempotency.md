# Case Study 06 — In-Memory Idempotency

**Status: CURRENT (replaced by durable idempotency in commits `a129852`, `8adecc7`, `0962284`)** · [Case studies](README.md) · Books: [07](../07-kafka.md), [08](../08-idempotency-and-distributed-operations.md) · Labs: [KF-07](../labs/kafka-labs.md#kf-07-redelivery-after-restart-is-skipped), [RD-07](../labs/redis-labs.md#rd-07-idempotency-lease-with-lua), [DS-04](../labs/distributed-systems-labs.md#ds-04-duplicate-payment-event)

## Symptom

After a service restart or a consumer-group rebalance, some events were handled **again**. The visible result was duplicate notifications.

## Root cause

The shared consumer deduplicated events with an in-process `Set<eventId>`. That set:
- was **empty after every restart**, while Kafka redelivers everything after the last committed offset;
- was **per replica**, so after a rebalance another instance received partitions it had never seen;
- grew without bound in memory.

Kafka delivers at least once, so duplicates are normal, and the dedup state must outlive the process.

## Why the naive version looked reasonable

- In a single-process dev run with no restarts, it works perfectly.
- It is fast and has no dependencies.
- Duplicates only appear on the unhappy paths (crash, deploy, rebalance), and those weren't tested.

## Impact

- Duplicate customer notifications on every deploy that landed mid-stream.
- Any non-idempotent handler would run its side effect twice.

## Fix

`DurableEventIdempotencyService` (`shared/src/kafka/durable-event-idempotency.service.ts`) stores state in Redis per **consumer group + event ID** (`kafka:idempotency:{group}:{eventId}`). Each state change is one atomic Lua script (`durable-event-idempotency.scripts.ts`):

| Step | Script | Meaning |
| --- | --- | --- |
| acquire | lease with an owner token and TTL | "I'm processing this" (others skip or wait) |
| markProcessed | processed marker with retention TTL (7 days) | "done, skip forever" |
| release | owner-only delete | "I failed; someone may retry" |

- `KafkaConsumerService` uses it when `KafkaModule` is registered with `durableIdempotency: true`. order-service and notification-service enable it.
- Redis runs with AOF on a volume, so markers survive a Redis restart.
- **Deterministic event IDs** (`lifecycleEventId`, UUID v5 in `shared/src/events/event-identity.ts`) mean a *re-published* event has the same ID and is deduplicated too.
- The offset is committed only after the event is handled, already handled, or dead-lettered.

## Tests

- `durable-event-idempotency.service.spec.ts` runs against a **real Redis** in CI, so the Lua scripts themselves are exercised.
- `kafka-consumer.service.spec.ts` covers redelivery being skipped.
- Live: [KF-07](../labs/kafka-labs.md#kf-07-redelivery-after-restart-is-skipped).

## Trade-offs

- Redis is now on the consumer's critical path. If Redis is unavailable, the offset is not committed and processing stalls instead of risking duplicates. Correctness wins over availability.
- Markers expire after 7 days, matching Kafka's default retention. A replay older than that would re-run handlers.
- Consumers without `durableIdempotency` still fall back to the in-process set, and a warning is logged.

## What can still go wrong

- **Idempotency is not atomicity.** A handler that writes to PostgreSQL and then crashes before `markProcessed` will run again. The handler itself must be idempotent (CAS writes, upserts); see [case study 01](01-failed-payment-race.md).
- A handler that runs longer than the lease TTL can be picked up twice.
- The producer side still has no outbox ([case study 13](13-transactional-outbox.md)).

## What a senior engineer would ask

1. Why per *consumer group* and not per event? (Each group must process the event once.)
2. Where else could the dedup state live (PostgreSQL in the same transaction as the handler's write)? What does that buy?
3. How do you size the retention TTL against topic retention and replay windows?
4. What happens on a duplicate with a *different* payload but the same event ID?
