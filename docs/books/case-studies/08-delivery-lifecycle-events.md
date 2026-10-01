# Case Study 08 — Delivery Lifecycle Events

**Status: CURRENT (commits `73d6944`, `67835d3`); consumers PARTIAL** · [Case studies](README.md) · Books: [07](../07-kafka.md), [09](../09-distributed-systems.md), [10](../10-microservices-and-domain-design.md) · Lab: [KF-14](../labs/kafka-labs.md#kf-14-delivery-lifecycle-trace)

## Symptom (before)

- `delivery.events` existed as a topic, and driver-service even subscribed to it, but **delivery-service never published to it**.
- Order status followed the delivery only through synchronous HTTP calls. If order-service was down at the wrong moment, the order was left behind (for example, still `DRIVER_ASSIGNED` after the delivery was `DELIVERED`). Nothing would ever repair it.
- On an empty broker, driver-service even crashed at boot subscribing to a topic nobody had created (fixed separately in `2bd0792`: consumers create their topics before subscribing).

## Root cause

- The event contract (`shared/src/events/delivery-events.ts`) was defined but never wired to a producer.
- The system relied on one delivery mechanism, HTTP, with no convergence path.

## Why the naive version looked reasonable

- HTTP calls give immediate consistency on the happy path, so the order screen updated "instantly".
- A topic with a consumer *looks* like an event-driven design in a diagram.

## Impact

- Orders could stall in a past status when a sync failed. The customer app showed the wrong stage forever.
- Driver release was coupled to a consumer that, as discovered during the fix, was itself unsafe (see below).

## Fix

- delivery-service publishes `delivery.created`, `driver_assigned`, `picked_up`, `in_transit`, `completed` and `cancelled` **after** its HTTP syncs succeed, with deterministic event IDs (`lifecycleEventId`).
- order-service consumes `driver_assigned`, `picked_up` and `completed` through `syncStatusFromEvent`:
  - a same-status event is a no-op;
  - a stale event is skipped.

  So late or redelivered events never fail the consumer.
- **driver-service stopped consuming delivery events.** Its "release the driver on completed" handler would either:
  - fail, because `AVAILABLE → AVAILABLE` is not a valid transition, or
  - on a *late* event, free a driver who was already on their **next** delivery.

  delivery-service releases drivers synchronously, and that is retry-safe ([case study 09](09-driver-availability-lifecycle.md)).
- Delivery actions became retry-safe (`advance()` in `services/delivery-service/src/services/deliveries.service.ts`). Repeating an action re-runs its side effects instead of answering 409, and the order is walked forward one step at a time.

## Tests

- `deliveries.service.spec.ts`: events published with deterministic IDs; a retry re-publishes the same ID.
- `orders.service.spec.ts`: delivery events converge the order; stale and same-status events are skipped.
- Live: [KF-14](../labs/kafka-labs.md#kf-14-delivery-lifecycle-trace) and [DS-06](../labs/distributed-systems-labs.md#ds-06-repeat-delivery-completion-with-a-service-down).

## Trade-offs

- **Two paths again** (HTTP sync + event), made safe by CAS and stale-skipping, as in [case study 01](01-failed-payment-race.md).
- Publishing *after* the HTTP syncs means a sync failure → no event → the client retries. The event is not a substitute for the retry; it is a second chance for the order to converge.

## What can still go wrong

- **No outbox:** a crash after the delivery write but before the publish loses the event ([case study 13](13-transactional-outbox.md)).
- **Notifications don't use the delivery events yet.** The `DRIVER_ASSIGNED` handler in notification-service is empty, because the payload has no `customerId` and nothing looks it up. Customers get no "driver assigned" or "delivered" notification from this path.
- No consumer handles `delivery.cancelled` for the order.

## What a senior engineer would ask

1. Should events be "thin" (IDs only, consumers fetch) or "fat" (include `customerId`, address)? What does each cost when the schema changes ([KF-13](../labs/kafka-labs.md#kf-13-event-contract-change))?
2. Why is "a late event frees the wrong driver" a *design* bug, not an implementation bug?
3. If HTTP syncs were removed, could the event path alone keep the order correct? What latency would the customer see?
