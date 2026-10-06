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
- Uses Redis for durable Kafka idempotency (consumer group `delivery-service-group`)
- Publishes `delivery.events`; consumes `order.ready_for_pickup` (auto-dispatch)

## Events published/consumed
## Driver card on the delivery read (#140)
`GET /deliveries/by-order/:orderId` includes `driver: { displayName, avatarUrl, vehicleType, licensePlate } | null`. This is what the order's customer (and its restaurant owner) may see about who is delivering.
- **Fields:** first name only, photo, vehicle and plate; never the phone, email, user id, identity data or location.
- **Order of checks:** authorization runs first, and the card is added only to a delivery the reader may already see.
- **How it's built:** server-side with the system token, from driver-service (vehicle) and user-service (name, photo), cached for 60 s.
- **When it's null:** while no driver is assigned, and whenever a lookup fails (the read itself still succeeds).

Every lifecycle transition publishes to `delivery.events`: `delivery.created`, `delivery.driver_assigned`, `delivery.picked_up`, `delivery.in_transit`, `delivery.completed`, `delivery.cancelled`. Payload: `{ deliveryId, orderId, customerId?, driverId?, assignedAt?, status }`.
- `customerId` was added in #5.
- `assignedAt` (#46) is when the current driver's claim was accepted. delivery-service writes it with the assignment, and it is the same on every event after that (see the assignment contract in [tracking-service](./tracking-service.md#assignment-and-eta-contract-46)).
- A delivery is assigned at most once, and `delivery.driver_assigned` is emitted exactly once: it has a deterministic event id, and a repeated assign request stages no event.

- Staged in the transactional outbox (`outbox_events`) in the same transaction as the delivery write, then published by the outbox relay (#98). The HTTP syncs to order-service and driver-service run after the commit; order-service also converges from the event, so a failed order sync is repaired without a client retry.
- Keyed by `orderId` (same partition as the order's own events).
- `eventId` is stable per (delivery, event type), so a re-publish is deduplicated by consumers.
- Published if and only if the delivery write committed, at-least-once (consumers deduplicate). A retried action stages nothing new (same `eventId`).

Consumed from:
- `order.events` → `order.ready_for_pickup` (auto-dispatch, below), with durable per-group idempotency

## Required env vars
From `services/delivery-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `ORDER_SERVICE_URL` (default: `http://localhost:3006`)
- `DRIVER_SERVICE_URL` (default: `http://localhost:3009`)
- `RESTAURANT_SERVICE_URL` (default: `http://localhost:3003`)
- `REDIS_URL` (default: `redis://localhost:6379`), for Kafka idempotency
- `AUTO_DISPATCH_SWEEP_MS` (default: `15000`), how often deliveries waiting for a driver are retried; `0` disables the retry (the E2E stack uses `2000`)
- `KAFKA_BROKER` (used in Docker Compose as `kafka:29092`)
- `PORT` (default: `3008`)
- `NODE_ENV` (default: `development`)

## Automatic dispatch

Orders reach a driver without anyone calling the API (`src/services/auto-dispatch.service.ts`):

1. **Trigger.** order-service publishes `order.ready_for_pickup` when the restaurant marks the order ready. delivery-service consumes it and creates the delivery through the normal `create` path. If a delivery already exists (a manual dispatch, or a replayed event), that one is used.
2. **Assignment** goes through the normal `assignDriver` path: the exclusive, compare-and-set driver claim (#33). The dispatcher acts with dispatch rights (ADMIN).
3. **No driver free.** The delivery stays `CREATED`, and the event counts as handled: it is not retried and not dead-lettered. Every `AUTO_DISPATCH_SWEEP_MS` (default 15 s) a sweep assigns waiting deliveries, oldest first, and stops at the first "no driver free". A waiting delivery is therefore assigned **within one sweep interval** of a driver coming online. Manually created deliveries that are still waiting are assigned by the sweep too.
4. **Duplicates and races:**
   - Redelivered and replayed events are deduplicated (durable idempotency). A delivery that is already assigned is left alone.
   - `deliveries.orderId` is unique. A manual create racing the automatic one gets `409` (not 500), and the dispatcher continues with the existing delivery.
   - The delivery transition is compare-and-set, and a lost assignment counts as done.
5. **Stale events.** An order that is no longer ready (e.g. cancelled) is skipped with a warning. Other failures (e.g. order-service down) are retried by the consumer and then dead-lettered.
6. **Lost events.** order-service stages `ready_for_pickup` in its outbox together with the status change, so the event is not lost on a crash or a Kafka outage (#98).

Manual `POST /deliveries` and `/assign` stay available to admins and restaurant owners.

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

If a request fails and the client **never** retries:
- The order sync is repaired from the committed delivery event (outbox).
- The driver release is repaired by the **driver reconciliation sweep** (#98). Every `DRIVER_RECONCILE_SWEEP_MS` (60 s) it releases drivers of recently finished deliveries who are still BUSY, have no active delivery, and whose status hasn't changed for `DRIVER_RECONCILE_GRACE_MS` (60 s).
- The grace period keeps it away from an assignment in progress.

Not covered: a driver claimed for an assignment that crashed before the delivery recorded them.

## Notes
Driver assignment is a core orchestration task in this service, with explicit transition rules. Some role restrictions are enforced inside the service rather than uniformly at the controller boundary.
