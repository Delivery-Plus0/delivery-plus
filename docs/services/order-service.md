# Order Service

## Purpose
Coordinates the ordering lifecycle and emits/consumes order payment and delivery events.

## Main REST endpoints
From `services/order-service/src/controllers/orders.controller.ts`:

- `POST /orders` – create an order from the current cart, optionally accepting an `Idempotency-Key` header for retry-safe creation
- `GET /orders` – list the current user’s orders
- `GET /orders/restaurant/:restaurantId` – list orders for a restaurant (owner only)
- `GET /orders/:id` – fetch an order by ID
- `PATCH /orders/:id/status` – transition status with role checks

## Idempotent order creation
`POST /orders` supports an optional `Idempotency-Key` header. The key is scoped to the authenticated customer and used to prevent duplicate order creation on client retry or network timeout.

Behavior:
- If the same customer retries the same key, the original order is returned instead of creating another order.
- If the request races with another request using the same customer+key, the first successful write wins; the losing request replays the stored order.
- Reusing the same key for a different cart or order is treated as a conflict and cannot silently alias to a different order.
- The key must be a visible ASCII string up to 255 characters; a UUID is the recommended format.

This is enforced in the application layer and backed by a database uniqueness rule on `(customerId, idempotencyKey)` where the key is not null.

## Delivery address

Every new order carries a drop-off address, **copied at checkout and never updated afterwards**: `deliveryAddress`, `deliveryNotes`, `deliveryLatitude`, `deliveryLongitude`.

- `POST /orders` accepts an optional JSON body (`CreateOrderDto`): `deliveryAddress` (≤ 500 chars, trimmed), `deliveryNotes`, and `deliveryLatitude` + `deliveryLongitude` (only together, and only with an address).
- Without `deliveryAddress`, the customer's profile address is used. It is read from user-service `GET /users/me` with the customer's own token.
- No address in either place → `400 A delivery address is required…`. Nothing is created and the cart is kept.
- Editing the profile later does not change placed orders. An idempotent retry returns the original order and its original address.
- Orders created before migration `003-order-delivery-address` have `null` address columns.

## Order outcomes and payment status (#143)

Every order that ends unsuccessfully says who ended it and why, recorded **with** the status change (same compare-and-set), never worked out by clients:

| End | `cancelledBy` | `cancellationReason` |
| --- | --- | --- |
| Declined payment → FAILED | `PAYMENT` | Your payment was declined, so the order was not placed. |
| Customer cancels | `CUSTOMER` | You cancelled this order. |
| Restaurant owner cancels | `RESTAURANT` | The restaurant cancelled this order. (+ `: <reason>` when the owner sends `reason`, ≤ 200 chars) |
| Platform cancels (ADMIN-role callers: delivery-service, support) | `SYSTEM` | Delivery Plus cancelled this order. (+ optional reason) |

`paymentStatus` (`PENDING` / `COMPLETED` / `FAILED`) is recorded from the payment events this service consumes. It never moves backwards and is independent of the order status, so a payment that completes after a cancellation is still visible (refunds: #53/#56).

Migration 005 backfills only what the stored status proves: FAILED orders → `PAYMENT` and payment FAILED; PAYMENT_PENDING → payment PENDING; orders past CONFIRMED → payment COMPLETED. Older CANCELLED orders keep both unknown (null).

`GET /orders?status=active|completed|cancelled` filters the customer's list: `cancelled` covers CANCELLED and FAILED.

## Restaurant operations (#154)

- **Rejecting an order:** a restaurant owner may cancel (reject) an order only while it is **CONFIRMED**, before preparing starts. From PREPARING on, it's a 409: "An order can only be rejected before you start preparing it."
  - The optional `reason` is recorded as "The restaurant cancelled this order: <reason>" (#143).
  - The reason travels on `order.cancelled` (`cancelledBy`, `cancellationReason`), and notification-service tells the customer.
  - The money isn't returned automatically yet: refunds are #53. The order keeps showing the payment as Paid.
- **Customer first name:** copied at checkout from the customer's profile (`customerFirstName`) so the kitchen can call the order out. Only the first name, never the surname or contact data. A profile outage never blocks checkout (null).
- **Today summary:** `GET /orders/restaurant/:restaurantId/summary` (owner only) returns today's (Africa/Cairo calendar day):
  - `orders`, `active`, `delivered`, `cancelled` (includes failed);
  - `revenue`: the items subtotal of orders that weren't cancelled or failed, in EGP. The delivery fee isn't the restaurant's.

## Dependencies
- Reads the current cart from `cart-service`
- Validates restaurant ownership through signed HMAC internal-auth requests and reads restaurant status from `restaurant-service`
- Reads the customer's profile address from `user-service` when checkout sends none
- Responds to payment and delivery events via Kafka consumers
- Persists order data in PostgreSQL

## Events published/consumed
Published to `order.events`:
- order created
- order status updated / completion signals

Consumed from:
- `payment.events` – payment outcome updates
- `delivery.events` – delivery status updates

Order events are staged in a transactional outbox (`outbox_events`, migration 004) in the same transaction as the order insert or status compare-and-set, and published by the outbox relay (`OutboxRelay` from `shared`; `OUTBOX_RELAY_INTERVAL_MS`, default 500 ms, plus an immediate kick after each commit). An event is therefore published if and only if its order change committed, even across a crash or a Kafka outage (#98). Consumers use the shared `KafkaConsumerService`.

Status updates are idempotent when the requested status already matches the stored status. This is required because payment creation synchronizes `PAYMENT_PENDING` directly and also publishes a Kafka event; the event consumer may legitimately observe the same transition. Duplicate delivery of the same status event therefore returns the current order instead of producing a false 409 conflict.

## Required env vars
From `services/order-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `CART_SERVICE_URL` (default: `http://localhost:3005`)
- `RESTAURANT_SERVICE_URL` (default: `http://localhost:3003`)
- `INTERNAL_AUTH_SECRET` (required in production; shared with restaurant-service)
- `INTERNAL_AUTH_SERVICE` (default: `order-service`)
- `USER_SERVICE_URL` (default: `http://localhost:3002`), used to read the customer's profile address at checkout
- `KAFKA_BROKER` (used in Docker Compose as `kafka:29092`)
- `PORT` (default: `3006`)
- `NODE_ENV` (default: `development`)

## Notes
This is one of the central orchestration services: it owns the order state machine and bridges cart, payment, and delivery flows.
