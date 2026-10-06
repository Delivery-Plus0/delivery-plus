# Known Issues and Gotchas

## 1. This is a learning/demo-oriented architecture

The project is intentionally structured like a practical microservice backend rather than a hardened production system. Several design decisions are deliberately simple and are meant to be understandable for local development rather than enterprise-scale operations.

## 2. Identity is split across services

The repo uses a shared canonical `userId` pattern, but the actual data is still stored in separate domains:

- `credentials` in auth-service
- `user_profiles` in user-service
- assorted ownership fields in domain services

This is a good pattern for a loosely coupled system, but it can be confusing if a contributor expects one central user table.

## 3. Event contracts are lightweight

Kafka topics are centrally named, but the payload schemas are not formalized in a single event registry. That means a contributor may need to inspect producer code and consumer behavior together to understand a message contract.

## 4. Async flows are not a replacement for strong consistency

The project uses Kafka for event propagation, but it does not implement distributed transactions or guarantee eventual consistency semantics across all operations. In practice, a service may update its own table before or after an event is consumed, depending on implementation details.

## 5. Redis is used for mutable runtime state, not long-term data history

The cart and tracking services store state in Redis because it is suited to low-latency, ephemeral data. This is intentional, but it means those domains should not be treated like permanent relational storage. Redis also holds caches, rate-limit counters, and internal-auth nonces. The Compose Redis has no persistence volume, so a recreated container starts empty; this matters most for the durable Kafka idempotency markers once consumers adopt them.

## 6. Local environment defaults are convenience defaults

Compose files use default credentials and secrets that are acceptable for local development but not for production. If this project is used beyond demo mode, it should be reworked with secure secrets and stronger deployment controls.

## 7. Service startup order matters

Because the architecture depends on Kafka, Postgres, and Redis, local startup can fail if containers come up in the wrong sequence. The compose file mitigates this with health checks and `depends_on` conditions, but it is still worth remembering when debugging local issues.

## 8. Cross-service call graphs can be confusing

One service may call another to validate menu ownership, restaurant existence, or driver state. The project is designed for modularization, but it can be harder to reason about than a single monolith when following a request end-to-end.

## 9. Gateway routing is a simplification

The gateway acts as a reverse proxy and documentation front door, but it is not modeled as a full API gateway with granular policy, rate limiting, or advanced observability features. It fits the repo’s lightweight architecture, not a production-grade edge layer.

## 10. Testing is not fully centralized

The workspace root defines commands, but actual validation is still service-specific and environment-aware. This means contributors should expect to run targeted checks and inspect health endpoints rather than rely on one single all-encompassing test suite.

## 11. Current implementation gaps

- Order and delivery events go through a transactional outbox (#98): they are published if and only if the state change committed. The order sync after a delivery action is also repaired without a client retry (order-service converges from the committed delivery event). A driver release that fails and is never retried is repaired by delivery-service's reconciliation sweep (BUSY, no active delivery, status unchanged for the grace period; #98).
- Notifications cover payment received, order confirmed, driver assigned, picked up and delivered (#5). Not yet: payment failed / order cancelled notifications (no notification types for them), retries and templates/preferences (#50, #51), push delivery.
- Kafka handlers must finish well within the 30 s session timeout and the 60 s idempotency lease; neither is enforced. Services have no graceful shutdown hooks, so a stopped consumer stays in its group until the session expires (resetting offsets has to wait for that).
- kafkajs logs `Topic creation errors` at ERROR on every consumer start when the topics already exist; it is harmless.
- Internal user profile creation requires HMAC service identity, and user profile lookup enforces owner or admin access.
- Outbound service HTTP clients use native `fetch` without a shared timeout, retry, or circuit-breaker policy, and TypeORM sets no statement timeout, so a handler's duration is not bounded.
- The payment service contains a manual SQL idempotency upgrade outside the normal TypeORM migration runner.
- Health routes (gateway included) are liveness checks; they do not verify Kafka, Redis, or downstream services.
- No CI workflow collects coverage.
- Automatic dispatch depends on `order.ready_for_pickup` being published; the outbox guarantees that once the order change committed (verified with Kafka down and order-service killed before publishing). Driver choice is "most recently updated AVAILABLE driver": no location, distance or fairness. The waiting-delivery sweep runs in every delivery-service replica (safe, because claims and transitions are compare-and-set, but redundant).
- A driver left BUSY by a crash **between claim and assignment** (no delivery ever recorded the driver) is still not reconciled: the reconciliation sweep only looks at drivers of finished deliveries.
- Self-registered `DRIVER` and `RESTAURANT_OWNER` accounts need no approval.

Open findings from the 2026-10-01 code review (mostly not filed as issues yet; the critical one, self-registered ADMIN, is fixed in #105, and the driver claim race in #107):

- The global error filter returns a raw `Error.message` for unexpected (non-`AppError`) 500s, which can leak driver/SQL details.
- Every service connects to PostgreSQL as the `postgres` superuser, and the runtime image has no `USER` (runs as root).
- System tokens are signed with the shared `JWT_SECRET` and carry `role: ADMIN`: any service (or a leaked `.env`) can mint any identity, and logs cannot tell a service from an admin.
- cart-service updates the cart with read-modify-write on one Redis JSON value, so two concurrent adds can lose one.
- The rate limiter runs `INCR` then `EXPIRE` (not atomic), so a crash in between leaves a key with no TTL. It fails closed (5xx) when Redis is down.
- TypeORM 0.3 ignores `undefined` values in `find` where-clauses by default (`findOne({ where: { id: undefined } })` returns an arbitrary row). There is no current bug, but setting `invalidWhereValuesBehavior: { undefined: 'throw' }` would remove the trap.
- Correlation ids propagate only from auth-service to user-service, not across other HTTP calls or Kafka.
- Media: a verified S3 object can be orphaned if the owning service's database write fails after the copy (see [15-media-and-storage.md](./15-media-and-storage.md)).
- `.gitignore` has no entry for local agent settings such as `.claude/`, so they show as untracked; stage files explicitly rather than with `git add -A`.

These are documented findings from the current source, not claims that the application should be changed as part of documentation work. Related GitHub roadmap items remain open unless the repository and GitHub state prove otherwise.

## 12. Roadmap and history

GitHub issues are the authoritative roadmap; an open issue is roadmap work, not evidence that the behavior exists. The current capability status, toolchain, CI coverage, and most recent merges are kept in [16-current-state.md](./16-current-state.md).

Earlier milestones still present in the code:

- order creation idempotency (PR #21)
- environment-specific Compose files and host Kafka exposure (PR #25)
- standardized service Swagger/OpenAPI DTO metadata (PR #27)
- the production database migration workflow in the Docker startup path (PR #29)

## 13. Dependency updates can pass on stale checks

Dependabot PRs are not re-tested when `dev` moves. `http-proxy-middleware` 4 (#78) passed its checks against an older base, then broke `dev` once another merged PR made a spec import the gateway's `main.ts`. Re-run or update a dependency PR from the current base before merging it.

## Source of truth

- Compose stack: [docker-compose.yml](../docker-compose.yml)
- Shared enums and state transitions: [shared/src/types/enums.ts](../shared/src/types/enums.ts)
- Shared Kafka topics: [shared/src/events/topics.ts](../shared/src/events/topics.ts)
- Service docs: [docs/services.md](../docs/services.md)
