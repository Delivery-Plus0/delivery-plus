# Case Study 03 — Public Driver Endpoint

**Status: CURRENT (fixed in commit `8f0ecc0`)** · [Case studies](README.md) · Books: [17](../17-security-engineering.md), [03](../03-http-apis-and-web.md) · Lab: [SEC-01](../labs/security-labs.md#sec-01-status-code-tour)

## Symptom

These routes answered **without any token**:
- `GET /api/drivers/available` listed every available driver, licence plates included.
- `GET /api/drivers/:id` returned any driver.
- `GET /api/tracking/driver/:userId` returned any driver's last location.

## Root cause

The routes existed for *service-to-service* use: delivery-service picks a driver from `available`, and tracking-service resolves a driver.
- They had no guards, and their Swagger summaries said "internal use".
- The gateway proxies every `/api/drivers/*` path. Only `/internal/*` paths are blocked at the gateway.

So "internal" was a comment, not a control.

## Why the naive version looked reasonable

- "Only our services call it" is true of the *callers you wrote*, not of the callers who can reach the URL.
- Adding a guard would have meant the calling services need a token, and there was no service identity yet.

## Impact

- **Privacy and safety:** a live list of drivers and their plates, plus each driver's location by user ID. This is stalking-grade data.
- **Reconnaissance:** driver IDs to use against other endpoints.

## Fix

- `services/driver-service/src/controllers/drivers.controller.ts`:
  - `available` is `@Roles(UserRole.ADMIN)`.
  - `:id` is DRIVER (only themself, `getByIdFor`) or ADMIN.
- `services/tracking-service/src/controllers/tracking.controller.ts`: the driver-location route is guarded to the driver themself or ADMIN. Customers read a location **through delivery ownership** (`/api/tracking/delivery/:id`).
- delivery-service and tracking-service call driver-service with a short-lived **system token** (`SystemTokenService`, ADMIN role). This trade-off is examined in [case study 18](18-system-token.md).

## Tests

- `drivers.controller.spec.ts` and `drivers.service.spec.ts` in driver-service.
- `tracking.controller.spec.ts` and `tracking.service.spec.ts` in tracking-service.
- Live: [SEC-01](../labs/security-labs.md#sec-01-status-code-tour) expects 403 for a customer on `/api/drivers/available`.

## Trade-offs

- A system token with the ADMIN role is broader than needed: the caller can do anything an admin can.
- The alternative, an HMAC-signed `/internal/*` route like the one for user creation ([ADR 001](../../adr/001-internal-service-authentication.md)), is narrower but costs a secret per service pair.

## What can still go wrong

- A new "internal" route added under a public prefix without a guard. Review gateway prefixes and guards together.
- `JWT_SECRET` is shared. Any compromised service can mint ADMIN tokens and call these routes.

## What a senior engineer would ask

1. Which routes are reachable through the gateway? Can you produce that list automatically from `services/api-gateway/src/route-policy.ts` and the controllers?
2. Should internal calls go through the gateway at all?
3. What is the minimum privilege delivery-service needs from driver-service? Can it be expressed as a role or a scope?
4. How would you notice in logs that someone had been enumerating `/api/drivers/:id`?
