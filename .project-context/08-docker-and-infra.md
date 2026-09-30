# Docker and Infrastructure

## Infrastructure stack

This repository is designed to run locally with Docker Compose. The setup includes both infrastructure services and application services.

The compose definition is in:

- [docker-compose.yml](../docker-compose.yml)

## Core infrastructure components

### PostgreSQL

- Service name: `postgres`
- Image: `postgres:16-alpine`
- Port: `5432`
- Mounted init script: [docker/postgres/init.sql](../docker/postgres/init.sql)

Purpose:

- durable relational storage for service-owned domain tables
- each service uses its own logical database name inside the same PostgreSQL instance

### Redis

- Service name: `redis`
- Image: `redis:7-alpine`
- Port: `6379`

Purpose:

- cart state (cart-service)
- last-known driver locations (tracking-service)
- response caching (restaurant-service, menu-service)
- rate-limit counters (auth-service, cart-service, order-service)
- one-time nonces for internal service authentication (user-service)
- durable Kafka idempotency markers (`kafka:idempotency:{group}:{eventId}`, order-service and notification-service)

The Compose Redis runs with AOF (`--appendonly yes`) on the `redis_data` volume, so a restart or recreate keeps carts and idempotency markers. `docker compose down -v` still removes them. Production should use a managed or replicated Redis. The CI workflow also starts a throwaway `redis:7-alpine` service so the shared idempotency tests run against real Redis.

### Kafka and Zookeeper

- `zookeeper` runs on port `2181`
- `kafka` runs on port `9092`
- Kafka UI is exposed on `8085`

Purpose:

- event transport between services
- asynchronous updates for order, payment, and delivery lifecycle changes

### S3-compatible media storage

- Dev and test overlays add a `media-storage` service on port `9000` (S3 API), with a persistent data volume. It runs SeaweedFS's S3 gateway rather than MinIO: MinIO's own images were pulled from Docker Hub (2026-09-11) and quay.io gated anonymous pulls behind a required license/account (2026-09-24), so there is no unattended way to run real MinIO in CI or a fresh clone anymore. SeaweedFS is Apache 2.0, freely pullable, and speaks the same S3 API `S3StorageService` already targets, so no application code changed. See [15-media-and-storage.md](15-media-and-storage.md) for the full rationale.
- A one-shot `media-storage-init` service creates the configured bucket, grants anonymous read only outside the `pending/` prefix (so unconfirmed uploads are not publicly downloadable), and expires temporary `pending/` uploads after one day via a bucket lifecycle rule. SeaweedFS's S3 gateway answers CORS preflight requests automatically, with no separate CORS configuration step needed for presigned POST uploads.
- User, restaurant, and menu services wait for bucket initialization. Production does not start `media-storage`; configure an S3 lifecycle rule to expire `pending/` objects after one day. The production Compose overlay requires the bucket, public/CDN URL, region, and S3 credentials through deployment environment variables. Never commit production credentials.

## Service startup model

The stack is built with health checks and `depends_on` conditions. This expresses the intended startup order, but it is not a complete readiness guarantee: Redis and Kafka readiness are not generally checked by application health endpoints, and the gateway's health route checks only its own process.

Examples from the compose file:

- `postgres` must be healthy before app services start
- `kafka` requires healthy `zookeeper`
- app services wait on infra and downstream dependencies before becoming healthy

## Application service startup pattern

The root build configuration uses a Docker build arg called `SERVICE_NAME` to build individual services. This is reflected in the root Dockerfile and the compose service definitions. Both Dockerfile stages use `node:22-alpine`; Node 20 is end-of-life and below the `^22.15.0` that `http-proxy-middleware` 4 requires.

The important behavior is:

- every service is containerized individually
- they all share the same infra dependencies
- network-level references use internal Docker hostnames such as `auth-service`, `order-service`, and `kafka`

## Health checks

Every app service, including the API Gateway, exposes a `/health` route and uses a Docker healthcheck like:

- `wget --spider -q http://localhost:<port>/health`

The gateway's `/health` is liveness only; it does not check downstream services.

## Environment conventions

The compose file uses environment variables for local defaults, including:

- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`

Most services receive connection URLs like:

- `DATABASE_URL=postgres://...@postgres:5432/<database_name>`
- `REDIS_URL=redis://redis:6379`
- `KAFKA_BROKER=kafka:29092`
- `AWS_S3_ENDPOINT=http://media-storage:9000` inside dev/test service containers, with `AWS_S3_PUBLIC_ENDPOINT=http://localhost:9000` for browser-facing presigned URLs

## Observability and debugging

The stack includes Kafka UI for broker inspection and service health checks for container readiness. This is enough for local development and debugging, but not for a full production observability stack.

## Database bootstrap and migration flow

The Compose stack uses a service-owned Postgres model. The Postgres container is named `postgres` and is configured with:

- `POSTGRES_USER=${POSTGRES_USER:-postgres}`
- `POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}`
- logical databases created by [docker/postgres/init.sql](../docker/postgres/init.sql)

This init script creates one logical database per service, such as `auth_service`, `user_service`, `order_service`, and `payment_service`. The Dockerized app services then connect using `DATABASE_URL` values such as `postgres://postgres:postgres@postgres:5432/order_service`.

The service applications are intentionally configured with `synchronize: false` and `migrationsRun: false` in their TypeORM config. That means the schema is created by TypeORM migration files stored under each service’s `src/database/migrations` directory, and the migration history table is used to track applied versions.

In Docker-based startup, each built service image runs the migration step before the application process starts. This is the repository’s deployment-safe path for fresh databases and local development, and it prevents untracked schema creation from runtime sync.

The repository provides WSL and Compose validation commands, but this context does not claim a successful full-stack run unless a current run has been recorded. Use `docker compose config --quiet`, `docker compose ps`, and targeted logs as the runtime evidence.

## Operational caveats

A few important caveats are worth keeping in mind:

- the stack is meant for local development and demo use
- service startup order matters, especially for Kafka and Postgres initialization
- environment defaults are intentionally simple and may be replaced in real deployments
- container health checks assume the service exposes `/health` correctly
- database schema changes must be shipped as migrations; runtime `synchronize` is disabled
- a migration is intended to be forward-only once it has run in shared environments

## Source of truth

- Compose stack: [docker-compose.yml](../docker-compose.yml)
- Shared init SQL: [docker/postgres/init.sql](../docker/postgres/init.sql)
- Root Docker build: [Dockerfile](../Dockerfile)
- Service environment wiring: [docs/services.md](../docs/services.md)
