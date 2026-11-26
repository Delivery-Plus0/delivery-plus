# ADR 002: Admin API conventions

- **Status:** Accepted (2026-11, Delivery-Plus0/delivery-plus#212)
- **Deciders:** Platform owner
- **Supersedes:** none
- **Depends on:** [ADR 001 — internal service authentication](001-internal-service-authentication.md), #202 (staff identities and the `perms` claim)

## Context

Staff (the admin console, milestone Production 3) need APIs that list, search and act across all data: orders, users, drivers, restaurants, payments, deliveries. Today admin access is scattered and unguarded as a set:

- `GET /drivers/available` and `PATCH /drivers/:id/verification`;
- `GET /orders/:id/fee-split`;
- `POST /payments/:id/refund`;
- `POST /deliveries/:id/cancel`.

Nothing lists all orders, users or restaurants, and any ADMIN can call everything.

## Decision

1. **Each service owns its admin routes.** Admin routes live in the owning service under `/admin/...` (for example `GET /admin/orders` in order-service). There is no central admin BFF that reads other services' databases — the same ownership and transaction boundaries as the public API apply.
2. **Gateway prefix.** The public prefix is `/api/admin/<service>/...` (for example `/api/admin/orders` proxies to order-service `/admin/orders`). The admin prefixes are ordinary `PROXIES` entries in `services/api-gateway/src/main.ts`; the rewrite maps the public prefix onto the service's `/admin/<service>` route space.
3. **One contract per audience.** Admin routes are excluded from the public OpenAPI (`public-openapi.ts` asserts no `/api/admin/` path in the public document). They are served as a separate `docs/openapi/admin.json`, generated and validated by the same `openapi:generate` / `openapi:validate` scripts and checked in CI alongside the public contract.
4. **Guard.** A shared `@RequirePermissions(...)` decorator and `PermissionsGuard` (`shared/src/nest/auth/permissions.ts`, introduced by #202) protect every admin route. The guard requires `role = ADMIN` **and** the `perms` claim to carry every listed permission. SYSTEM (service) tokens are never accepted on admin routes: the guard answers **401** before any permission check, so a service identity can never be mistaken for staff.
5. **List contract.** Every admin list route follows one shape: page pagination reusing the existing `PaginatedResult`, an explicit maximum page size of 100, explicit id/status filters, a free-text `q`, and a `sort` parameter. Timestamps are ISO 8601; Cairo-day filters take a `tz` parameter when added.
6. **Mutations are audited.** Every admin mutation requires a `reason` field and goes through the audit hook (#213) in the same transaction (outbox).
7. **CORS.** The admin console origin is added to `CORS_ORIGINS` per environment only; it is never a global default.

## Consequences

- Adding an admin surface is a normal service change: route, `@RequirePermissions`, contract entry, tests — no cross-service scaffolding.
- The public spec cannot silently grow an admin path; CI rejects it both by the generator's exclusion and the validator's assert.
- Permissions evolve in one place (`STAFF_PERMISSIONS` in the shared package); services only declare which ones they need.
- The free-text `q` on list routes must never do fuzzy scans across user data — it matches identifiers only, keeping staff search cheap and leak-free.

## Example

`GET /api/admin/orders?page=1&limit=50&status=active&sort=createdAt:desc` with a staff JWT holding `support.read` → order-service `GET /admin/orders` → `PaginatedResult<Order>`. A token without the permission gets 403; a SYSTEM token gets 401.
