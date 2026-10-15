# Payment Service

## Purpose
Handles simulated payment creation, processing, and status tracking for orders.

## Main REST endpoints
From `services/payment-service/src/controllers/payments.controller.ts` (exposed through the gateway under `/api/payments`):

- `POST /payments` – create a payment for an order (moves the order to `PAYMENT_PENDING`). Accepts an optional `Idempotency-Key` header.
- `POST /payments/:id/process` – simulate processing and settle to success or failure. Retry-safe.
- `GET /payments/:id` – get payment status
- `POST /payments/:id/refund` – support (ADMIN) refund of a completed payment, in full, with an optional `reason`. Repeating it returns the refunded payment.
- `GET /payments/:id/refund` – the payment's refund record (the paying customer or ADMIN); 404 when not refunded

## Refunds (#56)

The rules and state transitions are in [cancellation-and-refunds.md](../business/cancellation-and-refunds.md). In short:

- **Automatic.** payment-service consumes `order.cancelled` (consumer group `payment-service-group`). If the order's payment is `COMPLETED`, it refunds all of it (items + delivery fee). A payment that completes after its order was cancelled is refunded right away.
- **Once, auditable.** `PaymentsRepository.refundOnce` locks the payment row, writes the `refunds` record (initiator, reason, source, `provider = SIMULATED`) and moves the payment `COMPLETED → REFUNDED` in one transaction. `refunds.paymentId` is unique (migration 003).
- **Event.** `payment.refunded` (deterministic eventId per payment, `refundId` in the payload) is published like the other payment events, tracked by `publishedEventStatus`.
- **Sweep.** Every `PAYMENT_SIDE_EFFECTS_SWEEP_MS` (default 30000; 0 turns it off), events and order updates a failed or crashed request left owed are finished.
- **Simulated** until a real payment gateway exists.

## Idempotency and retries

Payment creation and processing are safe to retry after a client timeout or network error.

### `POST /payments` with `Idempotency-Key`

Clients should send a key they generate once per checkout attempt (a UUID v4 is recommended) and reuse it on every retry of that attempt.

```
POST /api/payments
Authorization: Bearer <token>
Idempotency-Key: 3f0c7a52-8d1e-4c1b-9a7e-5b2d6e8f1a90
Content-Type: application/json

{ "orderId": "..." }
```

| Situation | Response |
|---|---|
| First request with a key | `201` with the new payment (`PENDING`) |
| Retry with the same key and same `orderId` | `201` with the **original** payment in its current state (no new row, no second `payment.created`, no second order update) |
| Same key reused for a different `orderId` | `409 Conflict` |
| Order already has an active payment (other key, or no key) | `409 Conflict` |
| Malformed key (empty, > 255 chars, spaces or non-ASCII, header sent twice) | `400 Bad Request` |
| No key | Previous behaviour: one payment is created; a retry gets `409` because an active payment exists |

Rules:

- Keys are scoped to the authenticated customer: two customers can use the same key independently.
- Keys are stored with the payment and do not expire.
- The key is checked **before** the order status. After a successful first attempt the order is `PAYMENT_PENDING`, so without the key a retry would be rejected; with it, the retry returns the original payment.
- If the first attempt failed after the row was inserted (Kafka or order-service down), the payment exists and the retry with the same key finishes the missing side effects.

### One active payment per order

Independently of the key, the database allows at most one payment per order in `PENDING`, `PROCESSING` or `COMPLETED` (partial unique index `UQ_payments_active_order`). Concurrent create requests for one order produce exactly one payment; the others get `409`. `FAILED` and `REFUNDED` payments do not count, so a failed attempt can be followed by a new payment.

### `POST /payments/:id/process`

| Current status | Behaviour |
|---|---|
| `PENDING` | Atomically claimed (`UPDATE ... WHERE status = 'PENDING'`), settled to `COMPLETED` or `FAILED`, then side effects run. Only one concurrent request can claim it. |
| `PROCESSING` | Claim younger than `PAYMENT_PROCESSING_TIMEOUT_MS` (60 s): `409 Conflict`, another request is settling it; retry shortly. Older, or with no claim time (claimed before #18): this request takes the claim over atomically and settles the payment. |
| `COMPLETED` / `FAILED` | Returns the payment as-is. The outcome never changes on retry, even if `simulateFailure` differs. Only side effects that failed earlier are re-attempted. |
| `REFUNDED` | `409` invalid state transition (unchanged). |

### Shared internal client contract

Every internal client that interpolates a path or resource ID into a downstream HTTP URL must validate it before the fetch. The shared helper `assertValidUuidV4()` in `shared/src/utils/id.ts` enforces a strict RFC 4122 v4 UUID, and throws a `BadRequestError` if a caller supplies a raw route param, JWT subject, or tampered value instead of a real UUID.

This is intentionally enforced at the client boundary so malformed values are rejected before any SSRF-sensitive URL is constructed. The error remains a normal application error (`400 Bad Request`) rather than a suppressed or hidden runtime failure.

### Side effects: Kafka event + order update

Each status that has side effects (`PENDING` → `payment.created` + order `PAYMENT_PENDING`; `COMPLETED` → `payment.completed` + order `CONFIRMED`; `FAILED` → `payment.failed` + order `FAILED`) records its progress on the payment row:

- `publishedEventStatus` — status whose event was published
- `orderSyncedStatus` — status whose order update was applied

A retry performs only the steps whose marker does not match the current status, in order (event first, then order). If a step fails, the error is returned to the client, the payment keeps its state, and the next retry resumes from that step.

A short lease (`sideEffectsLeaseUntil`, 30 s, based on the database clock) ensures only one request performs side effects at a time. A retry arriving while another request holds it returns the settled payment (or `409` for a `PENDING` payment whose creation side effects are still running). If the holder crashes, the lease expires and a later retry takes over.

Before settling a `PENDING` payment, `process` first finishes any creation side effects still owed, so the order always goes `CREATED → PAYMENT_PENDING → CONFIRMED/FAILED`.

### Delivery guarantees and known limits

- Events are **at-least-once**. A crash between a successful Kafka publish and writing `publishedEventStatus` causes the next retry to publish again. Every re-publish uses the same deterministic `eventId` (UUID v5 of `paymentId:eventType`), so consumers can deduplicate — see `.project-context/05-event-driven-design.md`.
- The same crash window exists for the order update. If order-service rejects the repeated update as an invalid transition (the order is already `CONFIRMED`), the retry returns that error; the payment itself stays correct.
- A process that dies after claiming `PROCESSING` and before settling no longer leaves the payment stuck (#18). See [Stuck PROCESSING recovery](#stuck-processing-recovery-18).

### Stuck PROCESSING recovery (#18)

- **The claim:** claiming (`PENDING → PROCESSING`) stamps `processingClaimedAt` (database clock) and a fresh `processingToken`.
- **Takeover:** a claim older than `PAYMENT_PROCESSING_TIMEOUT_MS` (default 60 000) counts as abandoned. A retry of `POST /payments/:id/process` takes it over with an atomic `UPDATE … WHERE "processingClaimedAt" < now() - timeout`. Of many concurrent takeovers exactly one wins; the others get `409`.
- **Fencing:** settling is `UPDATE … WHERE status = 'PROCESSING' AND "processingToken" = <own token>`. A request whose claim was taken over writes nothing and returns whatever the new holder settled, so a payment is settled exactly once.
- **No retry ever comes:** every `PAYMENT_SIDE_EFFECTS_SWEEP_MS`, a payment still in `PROCESSING` after `PAYMENT_PROCESSING_ABANDON_MS` (default 15 min) is taken over and settled `FAILED` ("Payment processing was interrupted, so you were not charged."). The usual side effects follow: `payment.failed`, the order moves to `FAILED`, and the customer is told.
- **Deploying:** migration 004 adds both columns as nullable. Rows already stuck in `PROCESSING` have no claim time and count as abandoned, so they become recoverable right away instead of staying stuck.
- **Simulator only:** "not charged" and re-deciding the outcome on a takeover are correct because the simulator charges nothing until it settles. A real gateway must instead look the charge up by its idempotency key in `settle` and in the sweep, so a takeover can never charge twice.

## Database migration workflow

This service follows the repository-wide migration-first pattern.

- [docker/postgres/init.sql](../../docker/postgres/init.sql) creates the logical `payment_service` database.
- TypeORM creates the actual schema via the migration in `services/payment-service/src/database/migrations/001-initial-schema.ts`.
- runtime `synchronize` remains disabled; the application does not depend on automatic schema creation.
- the migration history table records the applied migration and prevents repeated schema creation.

For local development:

```bash
npm run migration:run --workspace=@food-delivery/payment-service
npm run migration:show --workspace=@food-delivery/payment-service
```

For Docker-based startup, the service image runs the migration before the service process starts. The expected flow is: Postgres container ready → migration executes → service boots successfully.

This keeps the `payment_service` database aligned with the entity definitions in [services/payment-service/src/entities/payment.entity.ts](../../services/payment-service/src/entities/payment.entity.ts) and preserves the repository’s production-safe migration model.

## Dependencies
- Calls `order-service` to confirm order ownership and update status
- Persists payment records in PostgreSQL
- Publishes payment events to Kafka

## Events published/consumed
Published to `payment.events` (payload `{ paymentId, orderId, amount, status }`, unchanged):
- `payment.created`
- `payment.completed`
- `payment.failed`

`eventId` is deterministic per payment and event type; see "Delivery guarantees" above.

Consumed from:
- none directly implemented in this service

## Required env vars
From `services/payment-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `ORDER_SERVICE_URL` (default: `http://localhost:3006`)
- `KAFKA_BROKER` (used in Docker Compose as `kafka:29092`)
- `PAYMENT_SUCCESS_RATE` (default: `0.9`)
- `PORT` (default: `3007`)
- `NODE_ENV` (default: `development`)

Test-only:

- `PAYMENT_TEST_DATABASE_URL` – disposable PostgreSQL database for `payments.repository.integration.spec.ts` (schema is dropped). When unset the integration suite is skipped.

## Testing

```
npm test -w services/payment-service

# including the PostgreSQL integration suite (race/uniqueness/migration):
docker compose up -d postgres
docker compose exec postgres psql -U postgres -c 'CREATE DATABASE payment_service_test'
PAYMENT_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/payment_service_test \
  npm test -w services/payment-service
```

## Notes
The implementation is intentionally simulation-based rather than a real payment gateway. The outcome is chosen by a configurable success rate.
