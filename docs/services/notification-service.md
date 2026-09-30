# Notification Service

## Purpose
Stores user notifications and subscribes to Kafka events. Order notification handling is implemented; payment and delivery handlers currently contain no-op behavior pending customer/order lookup and contract work.

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

Current handler status:

- order events: implemented notification persistence
- payment events: subscribed, handler currently no-op
- delivery events: subscribed (`delivery.driver_assigned`), handler currently no-op; the payload has no `customerId` yet

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
