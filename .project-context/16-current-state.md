# Current State

A one-page snapshot of what the platform does today, what is partial, and what is missing. Read it right after [01-project-overview.md](./01-project-overview.md) so later files are read with the right expectations.

Snapshot of `dev` after per-stage customer notifications (#129, 2026-10-06). Merged so far:
- Phase 1 and 2 cores, including the transactional outbox (#98).
- All of Phase 3 (automatic dispatch + driver contracts).
- All of Phase 4 (driver and restaurant clients, in their own private repos).
- The Phase 6 core (#5). When code and this file disagree, the code wins; update this file in the same PR that changes the behavior.

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
| Redis | `redis:7-alpine`, AOF persistence on the `redis_data` volume |
| Kafka | Confluent `cp-kafka` / `cp-zookeeper` 7.6.1, single broker |
| Object storage | Any S3-compatible store; SeaweedFS S3 gateway (`chrislusf/seaweedfs:4.47`) in dev/test Compose; real S3/CDN in production |

`http-proxy-middleware` 4.x (the gateway proxy) requires Node `^22.15.0`, which is why Node 20 is no longer supported anywhere in the repo.

## Capability status

| Capability | Status | Notes |
| --- | --- | --- |
| Registration, login, JWT, roles | Implemented | auth-service issues JWTs; shared guards enforce roles in each service. Public registration accepts only self-service roles (CUSTOMER default, RESTAURANT_OWNER, DRIVER; checked in the DTO and again in the service); ADMIN cannot be self-assigned (#105) |
| Email verification and failed-login lockout | Implemented | auth-service; Redis-backed rate limiting on auth routes |
| Service-to-service auth for internal routes | Implemented | HMAC-signed requests with one-time Redis nonces ([ADR 001](../docs/adr/001-internal-service-authentication.md)); trusted internal callers such as menu-service and order-service must present a valid signed identity before they can query the restaurant ownership boundary. |
| Restaurants, menus, carts | Implemented | Restaurant owners can list only their own restaurants via `GET /restaurants/me`; public read DTOs strip owner-only fields; the `GET /restaurants/:id/ownership/:userId` route is guarded by `InternalAuthGuard` before asserting ownership; and menu/order clients now sign the internal ownership check with the shared HMAC contract. |
| Order creation and lifecycle | Implemented | Idempotency-Key support on creation; state machine in `shared/src/types/enums.ts`; status writes are compare-and-set. Every new order copies a drop-off address at checkout (body `deliveryAddress`, or the customer's profile address; 400 if neither) (#95) |
| Payments | Implemented (simulated) | No real payment provider; durable idempotency, compare-and-set state machine, deterministic event IDs |
| Delivery and driver lifecycle | Implemented | **Automatic dispatch** (#97): delivery-service consumes `order.ready_for_pickup`, creates the delivery and assigns a driver; with no driver free the delivery waits and a sweep (`AUTO_DISPATCH_SWEEP_MS`, default 15 s) retries. Manual create/assign remain for admins and the order's restaurant owner. Driver claims are exclusive and compare-and-set; drivers only go online/offline themselves and cannot leave BUSY (#33). Drivers find their job with `GET /deliveries/me/current` (#96). Delivery reads follow JWT → order ownership (checked by order-service with the requester's token) or assigned driver or admin. Delivery actions are retry-safe. Driver profiles require a JWT: admin/service system token, or the driver themself |
| Delivery Kafka events | Implemented | Every delivery transition stages its `delivery.events` event in the outbox with the delivery write (the HTTP syncs run after the commit); order-service converges from them (tolerant of duplicates/stale events). driver-service consumes none (availability is set synchronously); delivery-service consumes `order.ready_for_pickup` |
| Tracking | Implemented (polling) | Last-known driver location in Redis with a TTL. `GET /tracking/driver/:userId` requires JWT (the driver themself or admin); customers go through `GET /tracking/delivery/:id`, which inherits delivery ownership and returns an explicit lifecycle state: `NO_DRIVER`, `AWAITING_LOCATION`, `LIVE`, `STALE` (older than `LOCATION_STALE_AFTER_SECONDS`), `ENDED` (no position after delivery or cancellation) (#32). The customer app shows `LIVE`/`STALE` positions on a map on the order screen (#132). No push yet |
| Notifications | Implemented (in-app) | One notification per customer-visible stage: payment received, order confirmed, driver assigned, picked up, delivered (#5); recipients come from the event's `customerId`, duplicates are dropped by durable idempotency. Mark-as-read is scoped to the owner (404 otherwise). No push yet |
| Media uploads (S3) | Implemented | Presigned POST, byte verification, content-addressed keys; see [15-media-and-storage.md](./15-media-and-storage.md) |
| Kafka reliability | Implemented (transactional outbox for order and delivery events, #98) | Durable Redis idempotency per consumer group (order-service, notification-service, delivery-service); 3 attempts, then `<topic>.dlq` with failure headers; `npm run kafka:dlq` lists/replays. Events keyed by `orderId`; order/delivery event ids are deterministic. Redis runs with AOF persistence. order-service and delivery-service stage events in `outbox_events` with the write and an `OutboxRelay` publishes them; delivery-service also sweeps for drivers left BUSY after a finished delivery (#127). Still missing: versioned event contracts (#23). See [05-event-driven-design.md](./05-event-driven-design.md) |
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
| #129 | Customer notification at every stage: `customerId?` on payment and delivery payloads (delivery stores it, migration 004); handlers for `payment.completed`, `delivery.driver_assigned`, `delivery.picked_up`, `delivery.completed`; events without `customerId` are skipped; `npm run e2e` and `seed:e2e` assert them (closes #5) |
| #128 | Owners can neither set nor lift `SUSPENDED`: owner status writes are compare-and-set against a non-suspended row (closes #125) |
| #127 | Driver-release reconciliation sweep in delivery-service (`DRIVER_RECONCILE_SWEEP_MS`, `DRIVER_RECONCILE_GRACE_MS`) (#98) |
| #126 | Transactional outbox for order and delivery events (`outbox_events`, `OutboxRelay`) (#98) |
| #124 | Gateway dev CORS allows the restaurant app E2E origin (:8085) |
| #123 | Restaurant ownership boundaries (#59): `GET /restaurants/me`, public restaurant DTOs, HMAC-protected ownership verification, signed menu/order internal clients, restaurant-order role guard, gateway blocking of public ownership probes |
| #111 | Gateway dev CORS allows the driver app E2E origin (:8084) |
| #110 | Automatic dispatch on `order.ready_for_pickup` with a waiting-delivery sweep; Redis + durable idempotency in delivery-service; concurrent create maps to 409; seeds and `npm run e2e` no longer dispatch by hand; seed-e2e drops scenario S3 (closes #97) |
| #109 | `GET /deliveries/me/current`: the calling driver's active delivery with pickup, drop-off, order summary and next actions; 204 when none (closes #96) |
| #108 | Orders snapshot the delivery address at checkout (`CreateOrderDto`, profile fallback, migration `003-order-delivery-address`) (closes #95) |
| #107 | Deterministic driver availability: (from → to) role rules, compare-and-set claims, retry-safe no-ops, delivery-service tries the next driver on a lost claim (closes #33) |
| #106 | Engineering learning library in `docs/books` |
| #105 | Public registration can no longer self-assign ADMIN (critical) |
| #104 | README and architecture Mermaid diagrams render on GitHub |
| #103 | Kafka reliability: durable idempotency wired into `KafkaConsumerService`, per-topic dead-letter topics + `npm run kafka:dlq` replay tool, `orderId` partition key, deterministic order/delivery event ids, delivery lifecycle events published, driver-service delivery consumer removed, Redis AOF persistence, notification-service on Redis |
| #102 | Hardening + E2E: delivery dispatch limited to the order's restaurant owner or admin; driver profile routes require JWT (self/admin/system); mark-notification-read scoped to the owner; cart's class-level `@RateLimit` now enforced (`RateLimitGuard` reads handler then class); refunds are admin/support-only; order status updates are compare-and-set (no duplicate `order.confirmed`); Kafka consumers ensure topics exist; isolated E2E environment (`docker-compose.e2e.yml`, `npm run e2e:env:up`, `npm run seed:e2e`, see `docs/e2e.md`); shared seed helpers in `scripts/lib/gateway-seed.ts` |
| #102 | Phase 0: a declined payment now ends the order `FAILED` in both writers (the order-service `payment.failed` consumer used to write `CANCELLED`, which made the HTTP sync 409 and `/payments/:id/process` return 500). Payment-event consumers skip same-status, stale, and late events. Added `order.payment_pending` / `order.failed` event types (previously mislabeled `order.created`). Ownership checks on delivery reads; the driver-location route is no longer public; new `GET /deliveries/by-order/:orderId` |
| #90 | `DurableEventIdempotencyService` in `shared/src/kafka`: Redis-backed, consumer-group-scoped, lease-based event deduplication with atomic Lua scripts |
| #91 | Node 20 → 22 in all workflows and the Dockerfile; api-gateway spec stubs the ESM-only `http-proxy-middleware` 4 so Jest can run |
| #78, #80, #82, #83 | Dependabot: `http-proxy-middleware` 4.2.0, `actions/setup-node` v7 (in `ci.yml`), `@types/bcrypt` 6, `@types/node` 26 |
| #89 | S3-compatible media uploads for avatars, restaurant images and menu item images; SeaweedFS replaces MinIO in dev/test Compose |
| #87 | Email verification and failed-login lockout in auth-service |

## Planned next

Tracked as GitHub milestones (Phase 1–9). Phase 3 (automatic dispatch + driver contracts) is complete.

1. **Phase 4 is complete.** Three private client repos, each with CI, Security and E2E workflows: `delivery-plus-customer-app`, `delivery-plus-driver-app` (#99, closed) and `delivery-plus-restaurant-app` (#100, closed). The business flow runs through all three UIs with no API stand-ins (customer-app #20).
2. **#98 transactional outbox + driver release reconciliation** (#126, #127): order and delivery events are published if and only if their change committed, and a driver release that failed and was never retried is repaired by a sweep.
3. **Phase 6 core** (#129): a notification for every customer-visible stage. Remaining in Phase 6: failed/cancelled-payment notifications, retries (#50), templates/preferences (#51), push.
4. **Next**: Phase 7 real-time tracking (#32, #46, #60: customer location UI, then SSE/WebSocket); #7 graceful shutdown.
5. **Open findings from the 2026-10-01 code review** (most unfiled): see [13-known-issues-and-gotchas.md](./13-known-issues-and-gotchas.md).

Open gaps and technical debt are listed in [13-known-issues-and-gotchas.md](./13-known-issues-and-gotchas.md).

## Source of truth

- Workflows: [../.github/workflows](../.github/workflows)
- Runtime image: [../Dockerfile](../Dockerfile)
- Compose: [../docker-compose.base.yml](../docker-compose.base.yml) plus the `dev`, `test` and `prod` overlays
- Shared library entry point: [../shared/src/index.ts](../shared/src/index.ts)
