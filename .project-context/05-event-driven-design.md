# Event-Driven Design

## Why Kafka is used here

This project uses Kafka as an asynchronous integration backbone between services. The purpose is to decouple status changes and downstream reactions from synchronous HTTP calls, but the current implementation is partial and remains at-least-once with process-local safeguards.

The core event topics are declared in:

- [shared/src/events/topics.ts](../shared/src/events/topics.ts)

The current topics are:

- `order.events`
- `payment.events`
- `delivery.events`

## Event topology

```mermaid
flowchart LR
    ORDER[Order Service] -->|order.events| KAFKA[(Kafka)]
    PAYMENT[Payment Service] -->|payment.events| KAFKA
    DELIVERY[Delivery Service] -->|delivery.events| KAFKA
    KAFKA --> NOTIF[Notification Service]
    KAFKA --> DRIVER[Driver Service]
    KAFKA --> ORDER2[Order Service]
```

## Topic responsibilities

### order.events

This is the primary orchestration topic. Orders emit events when the lifecycle moves across domain steps, such as:

- creation
- confirmation
- payment approval or failure
- preparation readiness
- pickup assignment
- delivery completion

The order service is the main producer of this topic. Downstream consumers can react without direct HTTP calls.

### payment.events

This topic captures payment state changes and is used to notify people or services that payment is complete, failed, or requires follow-up handling.

Typical consumers include:

- order-service for state updates
- notification-service for user notifications

Delivery semantics (payment-service):

- Events are published **after** the payment row is committed and are **at-least-once**: a retry after a failed or interrupted publish may send the same event again.
- `eventId` is deterministic: UUID v5 of `"<paymentId>:<eventType>"` in a fixed namespace (`PAYMENT_EVENT_NAMESPACE` in `payments.service.ts`). A re-published `payment.completed` for a payment always has the same `eventId`, so consumers must deduplicate by `eventId` (the shared `KafkaConsumerService` already skips ids it has processed, but its store is still in-memory; the durable `DurableEventIdempotencyService` described below is not wired into it yet).
- Each payment emits at most one event per type in normal operation; `publishedEventStatus` on the payment row tracks what was already published.
- The payload shape `{ paymentId, orderId, amount, status }` and event type names are unchanged; `eventId` remains a UUID, so existing consumers are unaffected.
- The order-service status update is a separate HTTP call, not driven by the event; it is tracked the same way (`orderSyncedStatus`) and retried by the client's next `process`/create retry, not by Kafka.
- payment-service owns the payment → order transition (`PENDING` → `PAYMENT_PENDING`, `COMPLETED` → `CONFIRMED`, `FAILED` → `FAILED`). order-service's payment-event consumers apply the **same** statuses as a convergence path (`syncFromPaymentEvent`): a same-status update is a no-op, and a stale or late event (e.g. `payment.failed` after the customer cancelled) is logged and skipped rather than retried. If the HTTP sync of a `FAILED` payment hits an order that is already terminal, payment-service marks it synced; a `COMPLETED` payment on a closed order still errors (needs a refund).
- order-service publishes `order.payment_pending` and `order.failed` for those transitions (added in Phase 0; they were previously mislabeled `order.created`).
- Order status writes are compare-and-set (`UPDATE … WHERE status = <expected>`): when the HTTP sync and the consumer race to the same status only the winner publishes, so `order.confirmed` (and its notification) is emitted once.

### Partitioning and topic provisioning

- The shared producer keys every message by the event's `correlationId`, which is generated fresh for each event. Events for one order therefore do not share a partition key; ordering per order only holds today because auto-created topics have a single partition. Keying by `orderId` is required before adding partitions.
- `KafkaConsumerService.subscribe` creates the topic first (idempotent, waits for a leader). Before this, a consumer subscribing to a topic nobody had produced to yet (driver-service → `delivery.events`) crashed on a fresh cluster.

### delivery.events

This topic is intended to capture delivery lifecycle changes:

- assignment to driver
- pickup started
- vehicle in transit
- delivery completed
- cancellation or failure

This is primarily relevant to delivery, tracking, and notification flows. The delivery service currently defines the event publisher and event-building code, but its lifecycle methods do not invoke publication consistently; treat delivery event propagation as partial.

## Event-driven patterns in the repository

### 1. Command and notification separation

Service APIs handle immediate command requests, while Kafka is used for background propagation of events.

Example pattern:

- user places order via gateway
- order-service validates and persists order
- order-service publishes an order lifecycle event
- other services react asynchronously

### 2. Persistence + projection model

The system keeps authoritative state in each service’s database, while Kafka events act as integration messages. This is a classic event-driven microservice pattern rather than a distributed transaction design.

The repository does not implement a centralized event store. Instead, each service persists its own domain truth and listens for only the events that matter to it.

### 3. Event consumer responsibilities

Services react to incoming events by updating their own internal state or creating follow-up side effects:

- `notification-service` subscribes to order/payment/delivery topics and persists order notifications; payment and delivery handlers currently contain no-op behavior because the required lookup/contract work is not implemented
- `driver-service` can react to delivery events when the lifecycle affects driver availability
- `order-service` can adjust its internal state based on payment or delivery outcomes

## Why this matters for maintainers

A key design principle in this repo is:

- the service database owns the current truth
- Kafka carries the change signal
- each consumer decides how to react

This avoids a single shared database but still allows loosely coupled coordination across services.

## Current implementation status

The repo contains an explicit Kafka topic registry and event-driven service relationships, but the event payload schema is still lightweight and mostly code-structure-driven rather than a fully mature contract registry.

Most of the actual event contracts are established implicitly through:

- shared topic names
- service-specific event listeners
- message content created by each producer

This means the project is best understood as a practical microservice event bus rather than a strict event-sourcing system.

### Reliability boundaries

- Consumer retries are limited to three attempts with exponential backoff in the process.
- `KafkaConsumerService` still stores processed event IDs in an in-memory `Set`; the state is lost on restart and is not shared across replicas.
- Exhausted messages are logged and their offsets are committed; no real dead-letter topic or persistence path is implemented.
- Payment events use deterministic event IDs and retry-aware payment markers, but publication remains at-least-once.
- Other producers (every order-service event, delivery-service's unused publisher) use random `uuidv4()` event IDs, so a duplicate publish cannot be deduplicated by consumers.
- A versioned event registry, runtime validation, consumer integration of durable deduplication, and DLQ handling remain roadmap work.

### Durable idempotency (available, not yet integrated)

`shared/src/kafka/durable-event-idempotency.service.ts` provides `DurableEventIdempotencyService`, a Redis-backed record of processed events built on the shared `REDIS_CLIENT`. It is exported from the shared package but **no consumer uses it yet**; `KafkaConsumerService` behavior is unchanged.

- Key per consumer group and event: `kafka:idempotency:{consumerGroup}:{eventId}`, with each segment URI-encoded so different pairs can never collide.
- Values: `lease:<token>` while a consumer is processing the event (expires after the lease TTL, default 60s), `processed` once handled (kept for the retention TTL, default 7 days, matching Kafka's default log retention).
- `tryAcquire` is the processing gate: it atomically returns `acquired` (with a lease token), `processed` (skip), or `in-progress` (another consumer holds it; do not process or commit).
- `markProcessed` records the event as processed and never rewrites an existing marker; `release` gives up a lease and only works for the lease owner. `isProcessed` is informational only and must not gate processing.
- Every operation is one Lua script, so each check-and-write is atomic and lease expiry uses the Redis clock. Redis errors propagate to the caller.
- Its tests run against an in-memory fake and, when `REDIS_TEST_URL` is set (as in the CI workflow), against a real Redis.

Integration constraints recorded for the follow-up work:

- The Compose Redis has no persistence volume, so recreating the container would drop every `processed` marker.
- driver-service and notification-service consume Kafka but do not register `RedisModule`; they need Redis before they can use the service.
- KafkaJS sends heartbeats only between messages (session timeout 30s), so handler time must stay well below both the session timeout and the lease TTL, or the lease needs renewal.

## Source of truth

For exact topic names, see:

- [shared/src/events/topics.ts](../shared/src/events/topics.ts)

For service-level wiring and relationship assumptions, see:

- [docs/services/order-service.md](../docs/services/order-service.md)
- [docs/services/payment-service.md](../docs/services/payment-service.md)
- [docs/services/delivery-service.md](../docs/services/delivery-service.md)
- [docs/services/notification-service.md](../docs/services/notification-service.md)
- [docs/services/driver-service.md](../docs/services/driver-service.md)
