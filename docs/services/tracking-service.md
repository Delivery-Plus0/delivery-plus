# Tracking Service

## Purpose
Collects real-time driver location updates and exposes delivery-tracking summaries.

## Main REST endpoints
From `services/tracking-service/src/controllers/tracking.controller.ts`:

- `POST /tracking/location` – driver reports their current location (DRIVER only, keyed by the token's user)
- `GET /tracking/driver/:userId` – fetch a driver’s last known location (the driver themself or admin)
- `GET /tracking/delivery/:deliveryId` – fetch delivery status plus driver location (delivery ownership is checked by delivery-service with the caller's token)

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

## Dependencies
- Uses Redis for location snapshots via `LocationRepository`
- Calls `delivery-service` and `driver-service` for verification and metadata
- Used by client tracking UI and operational dashboards

## Events published/consumed
- No Kafka producer/consumer is implemented in this service.

## Required env vars
From `services/tracking-service/src/config/app-config.ts`:

- `REDIS_URL`
- `JWT_SECRET`
- `DELIVERY_SERVICE_URL` (default: `http://localhost:3008`)
- `DRIVER_SERVICE_URL` (default: `http://localhost:3009`)
- `LOCATION_TTL_SECONDS` (default: `300`)
- `LOCATION_STALE_AFTER_SECONDS` (default: `60`; keep it below the TTL, or `STALE` never occurs)
- `PORT` (default: `3010`)
- `NODE_ENV` (default: `development`)

## Notes
This service is intentionally lightweight and focuses on location storage and retrieval rather than business logic.
