# ADR 0004 — `orderId` as the Partition Key

**Status:** Accepted (reconstructed from commit `8adecc7`) · [ADRs](README.md) · Books: [07](../07-kafka.md), [09](../09-distributed-systems.md) · Labs: [KF-03](../labs/kafka-labs.md#kf-03-partitions-and-keys), [KF-11](../labs/kafka-labs.md#kf-11-ordering-per-key)

## Context

- Kafka guarantees order **within a partition** only.
- An order's events come from three services (order, payment, delivery) and across three topics.
- Consumers converge status from them, and an out-of-order pair (`completed` before `picked_up`) must not move an order backwards.
- Before this decision, events were keyed by `correlationId`, which is a fresh ID per request. So one order's events could land in different partitions as soon as topics have more than one.

## Decision

The shared producer keys every event by `payload.orderId`, falling back to `correlationId` when an event has no order (`eventPartitionKey` in `shared/src/events/event-identity.ts`, used by `shared/src/kafka/kafka-producer.service.ts`).

## Alternatives considered

| Key | Effect |
| --- | --- |
| `correlationId` (previous) | related events scatter; no per-order ordering |
| entity ID (`paymentId`, `deliveryId`) | ordered per entity, not per order; an order's payment and delivery events are unordered relative to each other within one topic |
| `customerId` | per-customer ordering; hot keys for heavy users; not what consumers need |
| no key (round-robin) | best spread; no ordering |

## Consequences

**Good**
- All events of one order on one topic are ordered.
- Partition count can grow without consumers seeing reordering for a given order, though existing keys are remapped when the count changes.

**Costs and limits**
- **Ordering is per topic.** A `payment.completed` and a `delivery.created` are on different topics and can be consumed in either order. Consumers still need stale-event handling (`syncStatusFromEvent`).
- **Today every topic has one partition**, so the key has no effect on throughput yet. It prepares for scaling.
- Hot keys are not a concern: an order has a handful of events.

**Revisit when** a topic needs per-entity ordering that differs from per-order, or partitions are added. Increasing partitions remaps keys, so drain the topic or accept a brief reordering window.
