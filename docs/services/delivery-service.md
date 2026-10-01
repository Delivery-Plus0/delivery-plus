# Delivery Service

## Purpose
Owns delivery lifecycle management, driver assignment, and delivery status transitions.

## Main REST endpoints
From `services/delivery-service/src/controllers/deliveries.controller.ts`:

- `POST /deliveries` – create a delivery for an order ready for pickup
- `POST /deliveries/:id/assign` – assign an available driver
- `POST /deliveries/:id/pickup` – driver marks the order as picked up
- `POST /deliveries/:id/start` – driver starts the route
- `POST /deliveries/:id/complete` – mark the delivery as completed
- `POST /deliveries/:id/cancel` – cancel a delivery
- `GET /deliveries/me/current` – the calling driver's active delivery (DRIVER only; see below)
- `GET /deliveries/by-order/:orderId` – the delivery for an order (order owner, its restaurant owner, the assigned driver, admin)
- `GET /deliveries/:id` – get a delivery by ID

## Dependencies
- Calls `order-service` to validate order state and update order status
- Calls `driver-service` to find and update drivers, and to resolve the calling driver (`GET /drivers/me` with their own token)
- Calls `restaurant-service` (public read) for the pickup name and address
- Uses PostgreSQL for delivery records
- Publishes `delivery.events`

## Events published/consumed
Every lifecycle transition publishes to `delivery.events`: `delivery.created`, `delivery.driver_assigned`, `delivery.picked_up`, `delivery.in_transit`, `delivery.completed`, `delivery.cancelled`. Payload: `{ deliveryId, orderId, driverId?, status }`.

- Published after the HTTP syncs to order-service and driver-service succeed, so consumers see state the synchronous path already applied. A retried action re-publishes with the same `eventId`.
- Keyed by `orderId` (same partition as the order's own events).
- `eventId` is stable per (delivery, event type), so a re-publish is deduplicated by consumers.
- At-least-once and not transactional with the database write: a crash between the update and the publish loses the event (no outbox yet).

Consumed from:
- none directly implemented in this service

## Required env vars
From `services/delivery-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `ORDER_SERVICE_URL` (default: `http://localhost:3006`)
- `DRIVER_SERVICE_URL` (default: `http://localhost:3009`)
- `RESTAURANT_SERVICE_URL` (default: `http://localhost:3003`)
- `KAFKA_BROKER` (used in Docker Compose as `kafka:29092`)
- `PORT` (default: `3008`)
- `NODE_ENV` (default: `development`)

## Driver's current delivery

`GET /deliveries/me/current` (role DRIVER) lets a driver find their job without knowing any id:

1. **Identity.** The driver is resolved from **the caller's own token**: driver-service `GET /drivers/me`. No id comes from the request.
2. **Which delivery.** It is the driver's single non-terminal delivery (`findActiveByDriverId`). Claims are exclusive (#33). If drift ever leaves two, the most recently updated one is returned and a warning is logged.
3. **Response (200):**
   - `id`, `status`, `orderId` and timestamps;
   - `pickup` (restaurant id, name, address);
   - `dropOff` (the order's snapshot address, notes and optional coordinates; null fields for orders placed before addresses were stored);
   - `order` (item names and quantities, total);
   - `nextActions`: `pickup` when DRIVER_ASSIGNED, `start` when PICKED_UP, `complete` when IN_TRANSIT. Each maps to `POST /deliveries/:id/<action>`.
4. **204 No Content** when the driver has no active delivery, or no driver profile yet.
5. **Other roles get 403**, so the route can't be used to read someone else's delivery.

## Retry safety

Every action writes the delivery first (compare-and-set on the current status), then runs its side effects: driver release, order-service sync, event. If a side effect fails (a service is down, or delivery-service restarts mid-request), the request errors but the delivery has already moved. **Repeating the same action on a delivery already in the target status skips the write and re-runs the side effects** instead of answering 409, so a client retry always converges:

- `complete` / `cancel` release the driver **first** (so the driver is freed even if order-service is down), then sync the order, then publish. The release is idempotent (a driver who is no longer BUSY counts as released) and is skipped if the driver already has another active delivery.
- The order is moved forward along `READY_FOR_PICKUP → DRIVER_ASSIGNED → PICKED_UP → DELIVERED` one allowed step at a time, so an order left behind by an earlier failed sync catches up (`start` also syncs `PICKED_UP`). An order that left that path (e.g. `CANCELLED`) is not forced back; the delivery and the driver release still complete.
- `assignDriver` gives the claimed driver back if recording the assignment fails, and a retried assign on an already-assigned delivery does not claim a second driver.
- Re-published events keep their deterministic `eventId`, so consumers drop the duplicate.

Not covered: if a request fails and the client **never** retries, the side effects stay undone (e.g. a driver left BUSY). Closing that needs a transactional outbox or a reconciliation job.

## Notes
Driver assignment is a core orchestration task in this service, with explicit transition rules. Some role restrictions are enforced inside the service rather than uniformly at the controller boundary.
