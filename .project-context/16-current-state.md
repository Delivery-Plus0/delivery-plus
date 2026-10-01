# Current State

A one-page snapshot of what the platform does today, what is partial, and what is missing. Read it right after [01-project-overview.md](./01-project-overview.md) so later files are read with the right expectations.

Snapshot of `dev` at `1e6ec61` (2026-09-30). When code and this file disagree, the code wins; update this file in the same PR that changes the behavior.

## Platform at a glance

- Backend-only food-delivery platform: one API Gateway plus eleven NestJS domain services in a single npm-workspaces monorepo, sharing a `shared` package.
- Clients call only the gateway (`:3000`), which proxies by path prefix to the owning service.
- Nine services own a PostgreSQL database each (one Postgres instance, separate logical databases). Cart and tracking keep their state in Redis. The gateway owns no data.
- Services talk to each other over synchronous HTTP for lookups and state changes, and over Kafka (`order.events`, `payment.events`, `delivery.events`) for asynchronous reactions.
- Media (avatars, restaurant images, menu item images) goes directly from the client to S3-compatible object storage through presigned POST policies. Services store only URLs.

## Toolchain and runtime

| Area | Version / choice |
| --- | --- |
| Node.js | 22 LTS in every CI workflow and in both Dockerfile stages (`node:22-alpine`) |
| Language / framework | TypeScript 5.9, NestJS 10 |
| Tests | Jest 29 with ts-jest, one config per workspace |
| PostgreSQL | `postgres:16-alpine` |
| Redis | `redis:7-alpine` (no persistence volume in Compose) |
| Kafka | Confluent `cp-kafka` / `cp-zookeeper` 7.6.1, single broker |
| Object storage | Any S3-compatible store; SeaweedFS S3 gateway (`chrislusf/seaweedfs:4.47`) in dev/test Compose; real S3/CDN in production |

`http-proxy-middleware` 4.x (the gateway proxy) requires Node `^22.15.0`, which is why Node 20 is no longer supported anywhere in the repo.

## Capability status

| Capability | Status | Notes |
| --- | --- | --- |
| Registration, login, JWT, roles | Implemented | auth-service issues JWTs; shared guards enforce roles in each service |
| Email verification and failed-login lockout | Implemented | auth-service; Redis-backed rate limiting on auth routes |
| Service-to-service auth for internal routes | Implemented | HMAC-signed requests with one-time Redis nonces ([ADR 001](../docs/adr/001-internal-service-authentication.md)) |
| Restaurants, menus, carts | Implemented | Menu ownership is checked against restaurant-service; cart items are validated against menu-service |
| Order creation and lifecycle | Implemented | Idempotency-Key support on creation; state machine in `shared/src/types/enums.ts` |
| Payments | Implemented (simulated) | No real payment provider; durable idempotency, compare-and-set state machine, deterministic event IDs |
| Delivery and driver lifecycle | Implemented over HTTP | Delivery updates order and driver state through HTTP clients. Reads (`GET /deliveries/:id`, `GET /deliveries/by-order/:orderId`) follow JWT → order ownership (checked by order-service with the requester's token) or assigned driver or admin. No auto-dispatch: deliveries are created/assigned by explicit owner/admin calls. Create/assign/cancel are limited to admins and the owner of the order's restaurant (checked by order-service with the owner's token). Driver profiles (`GET /drivers/available`, `GET /drivers/:id`) require a JWT: admin/service system token, or the driver themself |
| Delivery Kafka events | Partial | Publisher code exists but lifecycle methods never call it, so consumers of `delivery.events` receive nothing |
| Tracking | Implemented | Last-known driver location in Redis with a TTL. `GET /tracking/driver/:userId` requires JWT (the driver themself or admin); customers go through `GET /tracking/delivery/:id`, which inherits delivery ownership |
| Notifications | Partial | Order-confirmed notifications are stored (one per order: order status writes are compare-and-set, so racing writers publish once); payment and delivery handlers are no-ops. Mark-as-read is scoped to the owner (404 otherwise) |
| Media uploads (S3) | Implemented | Presigned POST, byte verification, content-addressed keys; see [15-media-and-storage.md](./15-media-and-storage.md) |
| Kafka consumer reliability | Partial | Consumer still dedups with an in-memory `Set` and has no real DLQ. A durable Redis-backed `DurableEventIdempotencyService` exists in `shared` but is **not yet wired into** `KafkaConsumerService`. Consumers now create their topics before subscribing (a fresh cluster used to crash driver-service on boot). Events are keyed by a random per-event `correlationId`, so there is no per-order ordering guarantee once topics have more than one partition |
| Gateway health | Implemented | `GET /health` and `GET /health/live` (liveness only, no dependency checks) |
| Public API contract | Implemented | Generated OpenAPI at `docs/openapi/delivery-plus-public.json`, checked in CI |
| Push/email delivery, real payment provider, observability stack | Not implemented | Roadmap |

## Continuous integration

Every PR and push to `main`/`testing`/`dev` runs these workflows (`.github/workflows/`):

| Workflow | What it proves |
| --- | --- |
| CI | `npm ci`, lint, all workspace tests (with a real Redis service so the shared idempotency Lua scripts run against Redis), build; Compose config; Trivy scan of the gateway image |
| PR Quality Gate | Lint, unit tests (no infrastructure), build, regenerated OpenAPI contract must match the committed file; Compose config for base, dev, test and prod overlays |
| Security | CodeQL; `npm audit` (blocks on critical, reports high/moderate); Trivy filesystem and secret scan |
| Docker Build | Builds every service image and Trivy-scans each one |
| Integration | Boots the full Compose test stack, seeds data, runs the critical-path E2E script (`npm run e2e`) |
| Migration Verification | Runs every service's TypeORM migrations on fresh databases and checks none are pending; payment SQL upgrade test on real Postgres |

No workflow collects test coverage.

## Recent changes (newest first)

| PR | Change |
| --- | --- |
| _unmerged_ | Hardening + E2E: delivery dispatch limited to the order's restaurant owner or admin; driver profile routes require JWT (self/admin/system); mark-notification-read scoped to the owner; cart's class-level `@RateLimit` now enforced (`RateLimitGuard` reads handler then class); refunds are admin/support-only; order status updates are compare-and-set (no duplicate `order.confirmed`); Kafka consumers ensure topics exist; isolated E2E environment (`docker-compose.e2e.yml`, `npm run e2e:env:up`, `npm run seed:e2e`, see `docs/e2e.md`); shared seed helpers in `scripts/lib/gateway-seed.ts` |
| _unmerged_ | Phase 0: a declined payment now ends the order `FAILED` in both writers (the order-service `payment.failed` consumer used to write `CANCELLED`, which made the HTTP sync 409 and `/payments/:id/process` return 500). Payment-event consumers skip same-status, stale, and late events. Added `order.payment_pending` / `order.failed` event types (previously mislabeled `order.created`). Ownership checks on delivery reads; the driver-location route is no longer public; new `GET /deliveries/by-order/:orderId` |
| #90 | `DurableEventIdempotencyService` in `shared/src/kafka`: Redis-backed, consumer-group-scoped, lease-based event deduplication with atomic Lua scripts. Library only; not integrated yet |
| #91 | Node 20 → 22 in all workflows and the Dockerfile; api-gateway spec stubs the ESM-only `http-proxy-middleware` 4 so Jest can run |
| #78, #80, #82, #83 | Dependabot: `http-proxy-middleware` 4.2.0, `actions/setup-node` v7 (in `ci.yml`), `@types/bcrypt` 6, `@types/node` 26 |
| #89 | S3-compatible media uploads for avatars, restaurant images and menu item images; SeaweedFS replaces MinIO in dev/test Compose |
| #87 | Email verification and failed-login lockout in auth-service |

## Planned next (Kafka reliability track)

Planned, not implemented. Each step is intended as its own PR:

1. Wire `DurableEventIdempotencyService` into `KafkaConsumerService`: gate processing on `tryAcquire`, bound handler time below the Kafka session timeout and the lease TTL, and add Redis to the Kafka-consuming services that lack it (driver-service, notification-service).
2. A real dead-letter topic for messages that exhaust their retries.
3. Publish delivery lifecycle events from delivery-service.

Open gaps and technical debt are listed in [13-known-issues-and-gotchas.md](./13-known-issues-and-gotchas.md).

## Source of truth

- Workflows: [../.github/workflows](../.github/workflows)
- Runtime image: [../Dockerfile](../Dockerfile)
- Compose: [../docker-compose.base.yml](../docker-compose.base.yml) plus the `dev`, `test` and `prod` overlays
- Shared library entry point: [../shared/src/index.ts](../shared/src/index.ts)
