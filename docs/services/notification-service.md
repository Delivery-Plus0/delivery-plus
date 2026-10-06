# Notification Service

## Purpose
Stores user notifications and subscribes to Kafka events. The customer is notified at every stage they see: payment received, order confirmed, driver assigned, picked up, delivered (#5).

## Main REST endpoints
From `services/notification-service/src/controllers/notifications.controller.ts`:

- `GET /notifications` – list notifications for the current user
- `PATCH /notifications/:id/read` – mark one notification as read
- `PATCH /notifications/read-all` – mark all notifications as read

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
