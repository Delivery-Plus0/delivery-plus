# Notification Service

## Purpose
Stores user notifications and subscribes to Kafka events. The customer is notified at every stage they see: payment received, order confirmed, driver assigned, picked up, delivered (#5).

## Main REST endpoints
From `services/notification-service/src/controllers/notifications.controller.ts`:

- `GET /notifications` – list notifications for the current user
- `PATCH /notifications/:id/read` – mark one notification as read
- `PATCH /notifications/read-all` – mark all notifications as read

## Localized text (#151)

Each notification stores a **message key and its parameters** next to the English `title`/`message`. That way the apps can show it in the reader's language (Arabic or English). Older clients keep using the English text. Older rows have no key and are shown as stored.

| `messageKey` | `params` |
| --- | --- |
| `order.confirmed` | `orderId` |
| `payment.completed` | `orderId` |
| `delivery.driver_assigned`, `delivery.picked_up`, `delivery.delivered` | `orderId` |
| `order.cancelled` | `orderId`; `cancelledBy` (`RESTAURANT` / `SYSTEM`); `note`, the canceller's own words shown as written, when one was given |
| `payment.failed` | `orderId` (a declined payment: the order was not placed) |
| `payment.refunded` | `orderId`; `amount` (two decimals); `currency` (`EGP`) — #56 |
| `driver.application_approved`, `driver.application_rejected` | `note` (the reviewer's words to the driver, when given) — #215 |
| `restaurant.application_approved`, `restaurant.application_rejected` | `restaurantName`; `note` when given — #215 |
| `driver.suspended`, `driver.reactivated` | none — #215 |
| `driver.review_withdrawn` | none — #318 |
| `restaurant.review_withdrawn` | `restaurantName` — #318 |
| `restaurant.suspended`, `restaurant.reactivated` | `restaurantName` — #215 |
| `account.reactivated` | none — #215 (a suspension has no notice: the person can't sign in, and is told when they try) |

The #215 notices have type `ACCOUNT_UPDATE` (migration 006). They come from `admin.actions`: a staff action's audit event (#213) names the person to tell in `payload.notify`, so one action gives exactly one audit row and one notification. The staff's internal `reason` is never in a notice.

Parameters never hold personal data. Migration 004 adds both columns, nullable: `messageKey` (varchar(64)) and `params` (jsonb).

## Dependencies
- Uses PostgreSQL to persist notifications
- Subscribes to Kafka topics emitted by order, payment, and delivery flows
- Consumes events and records supported notifications for the receiving user

## Events published/consumed
Subscribed to:
- `order.events`
- `payment.events`
- `delivery.events`

Notifications created (recipient = the event's `customerId`):

| Event | Notification type | Title |
| --- | --- | --- |
| `payment.completed` | `PAYMENT_COMPLETED` | Payment Received |
| `order.confirmed` | `ORDER_CONFIRMED` | Order Confirmed |
| `delivery.driver_assigned` | `DRIVER_ASSIGNED` | Driver Assigned |
| `delivery.picked_up` | `PICKED_UP` | Order Picked Up |
| `delivery.completed` | `DELIVERED` | Order Delivered |

- `payment.events` and `delivery.events` carry an optional `customerId`. payment-service takes it from the payment; delivery-service stores the order's customer on the delivery at creation (migration 004).
- An event without `customerId`, i.e. one published before #5 or for a delivery created before migration 004, is skipped with a warning. It is never sent to a guessed recipient.
- Duplicates (Kafka redelivery, outbox re-sends) are dropped by durable idempotency on `eventId`, so each stage notifies once.
- Not notified: `delivery.created` (the order screen shows "Finding a driver") and `delivery.in_transit` (no matching notification type).

Published:
- none directly implemented in this service

## Required env vars
From `services/notification-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `KAFKA_BROKER` (used in Docker Compose as `kafka:29092`)
- `REDIS_URL` (processed-event markers for durable idempotency; Compose: `redis://redis:6379`)
- `PORT` (default: `3011`)
- `NODE_ENV` (default: `development`)

## Notes
This service mainly acts as an event consumer and notification inbox, keeping user-facing updates out of the core business services.

## Health and readiness

`GET /health`, `GET /health/live` and `GET /health/ready` are served from `services/notification-service/src/controllers/health.controller.ts`.

- `GET /health` and `GET /health/live` are liveness checks: process health only, no dependency checks.
- `GET /health/ready` checks PostgreSQL (`SELECT 1` via the TypeORM connection). Kafka readiness (`kafka` check: shared producer connected and consumer group joined) is included in `GET /health/ready` (#8); a Kafka failure answers 503.
