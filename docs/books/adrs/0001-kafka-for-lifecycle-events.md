# ADR 0001 — Kafka for Lifecycle Events

**Status:** Accepted (reconstructed teaching ADR) · [ADRs](README.md) · Books: [07](../07-kafka.md), [09](../09-distributed-systems.md)

## Context

- Order, payment and delivery changes matter to several services. notification-service tells customers. order-service converges status from payment and delivery outcomes.
- Calling every interested service synchronously couples producers to consumers' availability, and the list of consumers grows.

## Decision

- Publish lifecycle events to Kafka topics `order.events`, `payment.events` and `delivery.events` (`shared/src/events/topics.ts`), using the shared producer and consumer (`shared/src/kafka/`).
- Each event has `eventId`, `eventType`, `timestamp`, `correlationId` and `payload`.
- Event IDs are deterministic (UUID v5 from entity + type).
- Consumers deduplicate per group in Redis, retry 3 times, then dead-letter to `<topic>.dlq`.

## Alternatives considered

| Alternative | Why not (for this system) |
| --- | --- |
| synchronous HTTP fan-out only | producer must know and wait for every consumer; one slow consumer slows checkout |
| Redis Pub/Sub | no persistence; a consumer that's down misses events ([RD-08](../labs/redis-labs.md#rd-08-pubsub-vs-streams)) |
| Redis Streams | durable with consumer groups; less tooling and retention control than Kafka; plausible for this scale |
| RabbitMQ | good for task queues; replay of history is not its model |
| PostgreSQL `LISTEN/NOTIFY` / polling tables | simplest; ties all consumers to one database |

*The original motive for Kafka specifically is not recorded.* Replay, retention, consumer groups and per-key ordering are the properties the code relies on today.

## Consequences

**Good**
- Consumers are independent.
- History can be replayed ([case study 16](../case-studies/16-kafka-replay.md)).
- Per-order ordering comes from the key ([ADR 0004](0004-orderid-partition-key.md)).

**Costs**
- A broker to run: single node in Compose, one partition per topic.
- At-least-once delivery, so consumers must be idempotent.
- The dual-write problem, because there is no outbox yet ([ADR 0010](0010-transactional-outbox.md)).
- Many flows *also* use HTTP for immediate answers, so two paths must agree ([case study 01](../case-studies/01-failed-payment-race.md)).

**Revisit when** partitions or replicas are needed for throughput or durability (single broker = no replication), or when the HTTP syncs are replaced by consumers (Phase 9).
