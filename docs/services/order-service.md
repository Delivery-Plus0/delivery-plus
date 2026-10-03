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

The service uses the shared Kafka abstractions (`KafkaProducerService`, `KafkaConsumerService`) from the `shared` package.

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
