# Tracking Service

## Purpose
Collects real-time driver location updates and exposes delivery-tracking summaries.

## Main REST endpoints
From `services/tracking-service/src/controllers/tracking.controller.ts`:

- `POST /tracking/location` – driver reports their current location (DRIVER only, keyed by the token's user)
- `GET /tracking/driver/:userId` – fetch a driver’s last known location (the driver themself or admin)
- `GET /tracking/delivery/:deliveryId` – fetch delivery status plus driver location (delivery ownership is checked by delivery-service with the caller's token)
- `GET /tracking/delivery/:deliveryId/stream` – the same data pushed as Server-Sent Events (see [Realtime stream](#realtime-stream))

## Delivery tracking lifecycle
`GET /tracking/delivery/:deliveryId` always resolves to exactly one `tracking` state, so clients never infer meaning from a `null` location:

| `tracking` | When | `location` | `locationAgeSeconds` |
| --- | --- | --- | --- |
| `NO_DRIVER` | The delivery has no driver yet (waiting for dispatch) | `null` | `null` |
| `AWAITING_LOCATION` | A driver is assigned but has no stored position: never reported, or the last report expired (`LOCATION_TTL_SECONDS`) | `null` | `null` |
| `LIVE` | The driver's last report is at most `LOCATION_STALE_AFTER_SECONDS` old | the position | age in seconds |
| `STALE` | The last report is older than that (the driver stopped reporting, e.g. app closed or no signal) | the last position, to show as "last seen" | age in seconds |
| `ENDED` | The delivery is `DELIVERED` or `CANCELLED` | `null`, even while Redis still holds the driver's last report | `null` |

Rules:

- **Source of truth:** the delivery's current `driverId`. After a reassignment only the new driver's position is read, so the previous driver's position is never returned.
- **Tracking ends with the delivery:** a finished delivery skips the driver lookup and returns no position, so a driver's whereabouts are not visible to the customer after the job.
- **Retention:** each driver's last position is one Redis key with a TTL (`LOCATION_TTL_SECONDS`, default 300 s), refreshed on every report. There is no history.
- **Timestamps:** `updatedAt` is set by the server when the report arrives. An unreadable timestamp counts as no position; a timestamp in the future (clock skew) counts as age 0.
- **Failures:** if delivery-service or driver-service can't be reached, the request fails (4xx/5xx) instead of returning a misleading state.

Response (fields added in #32 are backward compatible):

```json
{
  "deliveryId": "…",
  "status": "IN_TRANSIT",
  "driverId": "…",
  "location": { "userId": "…", "latitude": 30.0444, "longitude": 31.2357, "updatedAt": "2026-10-06T12:00:00.000Z" },
  "tracking": "LIVE",
  "locationAgeSeconds": 8
}
```

## Realtime stream
`GET /tracking/delivery/:deliveryId/stream` (#134, #135) pushes the tracking read to the customer as it changes. It covers **customer delivery tracking only**.

**Transport: Server-Sent Events.** The customer only needs server → client updates, and SSE fits the existing setup better than WebSocket:
- It keeps the normal `Authorization` header, so the same `JwtAuthGuard` applies, with no token in a URL or a first message.
- It goes through the HTTP proxy gateway unchanged.
- It needs no new dependency: the Express response on the server, `expo/fetch` streaming in the app.

WebSocket would add gateway upgrade handling, `@nestjs/websockets`/`ws` and a custom auth handshake for a bidirectional channel nobody uses.

**Wire contract** (`Content-Type: text/event-stream`):

| Frame | When | Payload |
| --- | --- | --- |
| `event: tracking` | on open, then on every visible change | `data:` exactly the `GET /tracking/delivery/:id` response |
| `event: error` | the caller lost access (401/403/404, final) or a dependency failed (5xx, retry) | `data: {"statusCode", "message"}`; the server then closes |
| `: ping` | every `TRACKING_STREAM_HEARTBEAT_MS` (15 s) | none (keepalive; clients treat silence as a dead connection) |

After the `ENDED` snapshot the server closes the stream; no position is ever sent after the end.

**Authorization:**
- No JWT: 401 from the guard.
- Before the first byte, delivery-service authorizes the caller's token with the same rules as `GET`. Anyone else gets an ordinary JSON 403/404 and no stream.
- Every full reload re-authorizes, so a stream can't outlive its access or token.

**Where updates come from** (no second source of truth):
- **Driver reports:** `POST /tracking/location` stores the position as before, then publishes `tracking:driver:{userId}` on Redis.
- **Delivery changes:** tracking-service consumes `delivery.events` (Kafka group `tracking-service-group`: assigned/reassigned, picked up, in transit, delivered, cancelled) and publishes `tracking:delivery:{deliveryId}`.
- Messages are triggers only, with no position or customer data. Redis pub/sub fans them out to every tracking-service instance, so it works with several instances behind the gateway. No extra broker is added.

**Per subscriber** (`TrackingStreamService`, transport-agnostic; all rules come from `TrackingService`):
- **Open:** subscribe to the delivery channel → load and authorize the delivery → subscribe to its driver's channel → send the snapshot. A change in between triggers a recompute, so nothing is lost between the snapshot and the subscription.
- **Driver trigger:** recompute from the stored position (Redis only).
- **Delivery trigger, or every `TRACKING_STREAM_RESYNC_MS` (30 s):** reload the delivery (re-authorize), switch to a reassigned driver's channel, recompute. The resync also covers a lost pub/sub message (at-most-once).
- **LIVE position:** a timer recomputes right after it crosses `LOCATION_STALE_AFTER_SECONDS`, so `STALE` is pushed without any new event.
- **Ordering and duplicates:** recomputes run one at a time (coalesced), and a snapshot is sent only if tracking, status, driver or position changed. `locationAgeSeconds` alone never triggers a send; clients age it locally. Duplicate or out-of-order triggers therefore can't repeat or reorder what the client sees.
- **Load:** a location report costs one Redis read per subscriber of that driver, and a delivery change one delivery-service read per subscriber. Channels are ref-counted per instance.

**Logs** (no coordinates, no customer data): `tracking.stream.opened|rejected|failed|closed` (delivery, status, reason, duration, events sent, open count), `tracking.push.publish_failed`, `tracking.bus.*`, `tracking.bridge.skipped`. There is no metrics stack yet (#15).

**Not included:** ETA and assignment contracts (#46), trust boundaries for ETA/geofence/replayed client locations (#60), background location, push notifications, realtime for other screens or apps.

## Clients
- **Customer app:**
  - The order screen subscribes to the stream for an unfinished delivery and falls back to polling `GET` every 10 s only while the stream is down.
  - It shows `LIVE`/`STALE` positions as a pin on a street map ("Live" or "Last known location"), the other states as text only, and nothing once `ENDED` (#132, #136).
- **`npm run e2e`:**
  - Another customer gets 403 on both this route and `GET /tracking/driver/:userId`, and the stream gives 401 to an anonymous caller and 403 to another customer.
  - A new driver report reaches the customer's stream by push.
  - The stream follows the delivery to `ENDED` and closes.

## Dependencies
- Uses Redis for location snapshots via `LocationRepository`
- Calls `delivery-service` and `driver-service` for verification and metadata
- Used by client tracking UI and operational dashboards

## Events published/consumed
- **Consumes** `delivery.events` (all types, group `tracking-service-group`, no durable idempotency: a duplicate only causes one extra recompute) to trigger realtime updates.
- **Publishes** nothing to Kafka. Redis pub/sub channels `tracking:driver:{userId}` and `tracking:delivery:{deliveryId}` are internal triggers.

## Required env vars
From `services/tracking-service/src/config/app-config.ts`:

- `REDIS_URL`
- `JWT_SECRET`
- `DELIVERY_SERVICE_URL` (default: `http://localhost:3008`)
- `DRIVER_SERVICE_URL` (default: `http://localhost:3009`)
- `LOCATION_TTL_SECONDS` (default: `300`)
- `LOCATION_STALE_AFTER_SECONDS` (default: `60`; keep it below the TTL, or `STALE` never occurs)
- `TRACKING_STREAM_HEARTBEAT_MS` (default: `15000`)
- `TRACKING_STREAM_RESYNC_MS` (default: `30000`)
- `KAFKA_BROKER` (default: `localhost:9092`)
- `PORT` (default: `3010`)
- `NODE_ENV` (default: `development`)

## Notes
This service is intentionally lightweight and focuses on location storage and retrieval rather than business logic.
