# Audit Service

## Purpose
The append-only record of every staff action (#213): who did what, to what, when, and why. Approvals, suspensions, refunds and cancellations move money and lock people out, so each one is recorded in the same database transaction as the change and can never be edited or deleted.

audit-service is the 12th service. It has only staff routes; nothing about it is public.

## How an action reaches the log
1. A staff route (guarded by `PermissionsGuard`, ADR 002) makes its change in a transaction and calls `AdminAudit.record(manager, {...})` from `@food-delivery/shared` **inside that transaction**.
2. `AdminAudit.record` writes the event to the service's `outbox_events` table (the transactional outbox, #98). If the transaction rolls back, no event exists; if it commits, the event is published even if the process dies right after.
3. The service's `OutboxRelayService` publishes it to Kafka topic **`admin.actions`**.
4. audit-service consumes it (consumer group `audit-service-group`, durable idempotency) and inserts it into `audit_events`, keyed by `eventId`, so a redelivered event is stored once.

The services with an outbox for this are auth, user, driver, restaurant, menu and payment (#213), plus order and delivery (#98). auth, user, driver, restaurant and menu use Kafka only to publish (`KafkaModule.register({ producerOnly: true })`).

## Adding an admin mutation
1. Guard it with `@RequirePermissions(...)` (ADR 002) and take a `reason` in the body.
2. Make the change and call `AdminAudit.record(manager, {...})` in **one** `transaction(...)`, then `outboxRelay.kick()` after the commit.
3. Declare it in `ADMIN_SERVICE_DEFINITIONS` (`services/api-gateway/src/public-openapi.ts`) with its `requestBody` (with `reason` required) and its `auditAction`. `npm run openapi:validate` fails a mutation without either.
4. Test that the route writes exactly one audit event.

## The event (`admin.action` on `admin.actions`)
| Field | Notes |
| --- | --- |
| `eventId` | The row's primary key. Pass a deterministic id when an action can be retried. |
| `actorId`, `actorEmail` | The staff token's `sub` and email. |
| `permission` | The permission the route required, e.g. `onboarding.review`. |
| `action` | A dotted verb, e.g. `driver.approve`, `user.suspend`. |
| `targetType`, `targetId` | `USER`, `DRIVER`, `RESTAURANT`, `ORDER`, `DELIVERY`, `PAYMENT`, `MENU_ITEM` or `STAFF`, and its id. |
| `reason` | Required on every admin mutation; `AdminAudit.record` refuses an empty one. |
| `before`, `after` | Only the fields the action changed (`auditDiff`). |
| `service`, `correlationId`, `occurredAt` | |
| `notify` | Optional (#215): `{userId, messageKey, params}`, the person notification-service tells about the action. Not stored in the audit log's columns. |

**Redaction:** `redactAuditFields` replaces values whose key names a password, token, hash, OTP or verification code, API key, signature, any `...Url`/`...Key` of a stored object (private documents), or a phone number with `[redacted]`. The log line for a consumed event carries ids and the action only, never the reason or the values.

## Append-only storage
Migration `001-audit-events`:
- triggers `TRG_audit_events_append_only` (UPDATE, DELETE) and `TRG_audit_events_no_truncate` raise `audit_events is append-only` for everyone, superusers included;
- `UPDATE`, `DELETE` and `TRUNCATE` are revoked from `PUBLIC` and from the service's own database user.

CI proves both: the migration workflow tries UPDATE, DELETE and TRUNCATE and expects each to fail, and `audit-events.repository.integration.spec.ts` runs against Postgres.

## REST endpoint
| Gateway | Service | Permission |
| --- | --- | --- |
| `GET /api/admin/audit` | `GET /admin/audit` | `audit.read` |

Query (ADR 002 list contract): `page`, `limit` (≤ 100, default 50), `actorId`, `targetType`, `targetId`, `action`, `from` (inclusive) and `to` (exclusive), ISO 8601. Newest first. Returns a `PaginatedResult<AuditEvent>`. Contract: `docs/openapi/admin.json`.

## Dependencies
- PostgreSQL (`audit_service` database)
- Kafka (consumes `admin.actions`)
- Redis (durable consumer idempotency, rate limits)

## Required env vars
- `DATABASE_URL`, `JWT_SECRET`
- `REDIS_URL` (default `redis://localhost:6379`), `KAFKA_BROKER` (default `localhost:9092`)
- `PORT` (default `3012`), `SERVICE_NAME`, `NODE_ENV`

## Health and readiness
`/health`, `/health/live`, and `/health/ready` (Postgres and Kafka, like notification-service).

## Existing environments
`docker/postgres/init.sql` creates `audit_service` on a **new** Postgres volume only. On an environment whose volume already exists, create it once before deploying:

```bash
docker compose exec postgres psql -U "$POSTGRES_USER" -c 'CREATE DATABASE audit_service'
```
