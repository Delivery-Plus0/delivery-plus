# Local Stack Troubleshooting

This runbook covers the repository's committed Docker Compose workflow. It is for local diagnosis only; it is not a production deployment procedure.

## Validate configuration first

From the repository root:

```bash
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml ps --all
```

The first command validates interpolation and Compose syntax. The second shows service state. If no containers are listed, no runtime logs are available from the current Docker context.

## Start-up sequence

```bash
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml ps --all
docker compose -f docker-compose.yml logs --no-color --tail=200 <service>
```

Infrastructure services are PostgreSQL, Redis, Zookeeper, Kafka, Kafka UI, and (in the dev and test overlays) `media-storage` (SeaweedFS S3 gateway on port `9000`) with its one-shot `media-storage-init` bucket initializer. Application services wait on Compose health conditions for their declared dependencies. This is an ordering aid, not a complete readiness guarantee.

## Healthcheck limitations

Compose probes `/health` on every service, including the API Gateway on port `3000`. The gateway's route is liveness only: a healthy gateway proves its process responds, not that downstream routes work. Test a known proxied route separately.

The domain services expose `/health` routes. Their readiness controllers may query PostgreSQL, but application readiness does not generally verify Kafka or Redis availability.

## Bootstrap and UUID-default failures

Run the API seed only after the gateway and dependent services are healthy:

```bash
npm run seed
npm run e2e
```

The seed is API-only and must not connect directly to PostgreSQL. It creates or reuses the owner, customer, driver, restaurant, category, and menu item, then drives a cart, order, payment, delivery, and tracking scenario. A rerun logs into existing accounts and creates a new transactional scenario.

If seed fails with `null value in column "id"`, inspect the live default instead of adding a manual ID to the seed:

```bash
docker compose exec postgres psql -U postgres -d restaurant_service \
	-c "SELECT column_name, column_default, is_nullable, data_type FROM information_schema.columns WHERE table_name = 'restaurants' AND column_name = 'id';"
```

The result must show `gen_random_uuid()` as `column_default`. If the database already existed before the UUID fix, rebuild/recreate the affected service so migration `002-uuid-primary-key-defaults` runs. If testing from zero, use `docker compose down -v` before rebuilding; this removes all local data.

`npm run seed:demo` follows the same API-only rule and adds richer demo data for the customer app. It uses its own `demo.driver@example.com`, which stays BUSY on the demo's "on the way" order, so `driver@example.com` remains available for the base seed and E2E. Unlike the base seed, it waits out `429` responses and retries.

If seed receives `429 TooManyRequests` during repeated setup, wait for the auth rate-limit window to expire. The seed logs in before attempting registration for known accounts and does not weaken the authentication limiter.

In CI, the integration workflow clears the test Redis database between seed and E2E. This resets rate-limit counters while preserving PostgreSQL users, restaurants, menu items, and other seeded records.

If E2E reports no restaurants or menu items, seed did not complete. Fix the first seed error and rerun `npm run seed` before running E2E.

## Database and migrations

PostgreSQL creates the service databases from `docker/postgres/init.sql` on first initialization. PostgreSQL-backed application containers run TypeORM migrations during image startup; cart, tracking, and the gateway skip the TypeORM migration path because they do not own relational schemas.

Check migration output with:

```bash
docker compose -f docker-compose.yml logs --no-color --tail=200 <postgres-backed-service>
```

TypeORM configuration uses `synchronize: false` and `migrationsRun: false`. The payment service also contains a manual SQL upgrade under `services/payment-service/migrations/`; that file is not automatically executed by the normal TypeORM migration runner and must be handled explicitly when applicable.

## Kafka and Redis checks

Kafka clients inside Compose use `kafka:29092`; host tools use the published `localhost:9092` listener. Kafka UI is published on `localhost:8085` by the development overlay.

Redis-backed cart and tracking state is ephemeral. A Redis restart can remove current cart/location state unless the configured volume or recovery process preserves it.

Redis in Compose has no persistence volume, so recreating the container also clears caches, rate-limit counters, and internal-auth nonces.

The shared Kafka consumer retries a handler three times with exponential backoff. It keeps processed event IDs only in memory. After retries are exhausted it commits the offset and logs a DLQ message, but no actual dead-letter topic is implemented. The shared `DurableEventIdempotencyService` (Redis keys `kafka:idempotency:{group}:{eventId}`) is not wired into the consumer yet, so those keys will not appear in Redis.

## Escalation notes

Record a reproducible symptom, the affected service, the relevant Compose logs, and whether the issue is caused by configuration, dependency readiness, migration state, or application behavior. Never place passwords, tokens, or complete secret-bearing environment values in an issue or documentation.

## Related documentation

- [Deployment](../deployment.md)
- [Architecture](../architecture.md)
- [Docker and infrastructure context](../../.project-context/08-docker-and-infra.md)
- [Known issues and gotchas](../../.project-context/13-known-issues-and-gotchas.md)
