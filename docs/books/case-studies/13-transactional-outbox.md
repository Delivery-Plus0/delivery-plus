# Case Study 13 — Transactional Outbox

**Status: PLANNED ([#98](https://github.com/Yousefa7medmaher/delivery-plus/issues/98)); not implemented** · [Case studies](README.md) · Books: [08](../08-idempotency-and-distributed-operations.md), [27](../27-advanced-data-patterns.md) · ADR: [0010](../adrs/0010-transactional-outbox.md) · Lab: [DS-11](../labs/distributed-systems-labs.md#ds-11-outbox-simulation)

## The problem (CURRENT)

Every service writes to PostgreSQL and **then** publishes to Kafka, as separate operations. In `OrdersService.createFromCart` (`services/order-service/src/services/orders.service.ts`):
```ts
const order = await this.orders.create(...);         // 1. DB commit
await this.cartClient.clearCart(authHeader);         // 2. HTTP
await this.kafkaProducer.publish(TOPICS.ORDER_EVENTS, { ... });  // 3. Kafka
```

| Crash or failure point | Result |
| --- | --- |
| after 1, before 3 | order exists, **`order.created` never published**; no notification, and any downstream projection misses it |
| Kafka down at 3 | the request fails *after* the order was committed; the client retries and the idempotency key returns the existing order **without publishing** |
| publish succeeds, DB rolls back (other flows) | consumers see an event for something that doesn't exist |

This is the **dual-write problem**: two systems, no shared transaction.

## Why the current version is reasonable for now

- Kafka is usually up. Deterministic event IDs make re-publishing safe, and consumers skip duplicates.
- Many important transitions also have an HTTP path ([case study 01](01-failed-payment-race.md)), so a lost event is often survivable.
- An outbox adds a table, a relay process and operational work per service.

## The design (PLANNED)

```text
BEGIN;
  INSERT INTO orders ...;
  INSERT INTO outbox (id, topic, key, payload, created_at) VALUES (<eventId>, 'order.events', <orderId>, ...);
COMMIT;

relay (loop):
  SELECT ... FROM outbox WHERE published_at IS NULL ORDER BY created_at
    LIMIT 100 FOR UPDATE SKIP LOCKED;
  produce each to Kafka (key = orderId) and wait for acks;
  UPDATE outbox SET published_at = now() WHERE id = ANY(...);
```
- **Atomic:** the business row and the event commit together or not at all.
- **At least once:** the relay may publish twice (crash after produce, before update). That is fine, because event IDs are deterministic and consumers are durably idempotent ([case study 06](06-in-memory-idempotency.md)).
- **Ordering:** order per key by `created_at`. With several relay workers, partition the work by key or accept per-key ordering only within one worker.
- **Cleanup:** delete or archive published rows on a schedule.
- **Alternative relay:** CDC (Debezium reading the WAL) instead of polling. It gives lower latency, but it's another system to run.

## Tests the implementation will need

- Kill the relay between produce and mark: the event is published twice, and consumers handle it once.
- Kafka down for 5 minutes: requests still succeed, the outbox backlog grows, then drains in order.
- The business transaction rolls back: no outbox row, no event.

## What can still go wrong (even with an outbox)

- Relay lag becomes a new metric to watch ([case study 17](17-consumer-lag.md)).
- HTTP side effects (cart clear, order sync) are still dual writes. An outbox only covers events.
- Schema changes to payloads now have a table holding old versions.

## What a senior engineer would ask

1. Which service gets the outbox first, and why (order-service: the most events and the most consumers)?
2. Polling relay or CDC? What does the team already operate?
3. How do you prove ordering per order is preserved?
4. What is the rollout: dual-publish behind a flag, then switch?
