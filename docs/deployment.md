# Deployment and Local Infrastructure

## Prerequisites

Use Node.js 20+, npm, and Docker Desktop with Compose v2. Copy `.env.example` to `.env` for local commands, but do not commit the copy.

## Docker Compose

This repository provides a full local Compose file at [docker-compose.yml](../docker-compose.yml) plus committed base, development, test, and production overlays. The base file defines PostgreSQL 16, Redis 7, Zookeeper, and Kafka; the overlays add application services and environment-specific ports/configuration. `docker-compose.override.yml` is ignored for local-only customization.

```bash
# start the committed full local stack and wait for application healthchecks
docker compose -f docker-compose.base.yml -f docker-compose.dev.yml up -d --build --wait --wait-timeout 300

# after the stack is healthy, bootstrap through the public API and validate it
docker compose -f docker-compose.base.yml -f docker-compose.dev.yml ps
npm run seed
npm run e2e

# start the full stack
docker compose up -d --build

# validate the committed development graph in Linux/WSL
docker compose -f docker-compose.base.yml -f docker-compose.dev.yml config --quiet
docker compose -f docker-compose.base.yml -f docker-compose.dev.yml ps --all
```

```powershell
# PowerShell (WSL-hosted validation is also supported)
docker compose config --quiet
docker compose up -d --build
```

The root multi-stage `Dockerfile` accepts `SERVICE_NAME` and builds the shared package followed by the selected service.

For local media uploads, start the dev overlay (`docker compose -f docker-compose.base.yml -f docker-compose.dev.yml up`) so MinIO and its bucket initializer are included. The production overlay requires `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`, and `AWS_PUBLIC_BASE_URL`; use deployment secrets, not committed credentials. `AWS_REGION` defaults to `us-east-1`; endpoint variables are only needed for S3-compatible providers or private/CDN URL layouts.

PostgreSQL creates these logical databases: `auth_service`, `user_service`, `restaurant_service`, `menu_service`, `order_service`, `payment_service`, `driver_service`, `delivery_service`, and `notification_service`. Compose passes each service its own database URL via `DATABASE_URL`.

The repository provides Compose validation commands, but this document does not claim that the full stack has been started successfully in every environment. Validate the local runtime with `docker compose config --quiet`, `docker compose ps`, and targeted service logs.

Internal containers communicate using Docker DNS names such as `http://order-service:3006`, `redis://redis:6379`, and `kafka:29092`. For local host access, Kafka is published as `127.0.0.1:9092` and is reachable from tools running on the machine as `localhost:9092`. Kafka UI remains exposed locally on `127.0.0.1:8085` and connects to the Compose network via `kafka:29092`.

Listener summary:

- Docker services → `kafka:29092`
- Host development tools → `localhost:9092`
- Kafka UI → `localhost:8085`

## Database migrations

This repository uses a migration-first database workflow for every PostgreSQL-backed service.

### Local generation and execution

Start the infrastructure first:

```bash
docker compose up -d postgres redis zookeeper kafka
```

Create or update the service schema from the service folder:

```bash
npm run migration:generate --workspace=@food-delivery/order-service
npm run migration:run --workspace=@food-delivery/order-service
npm run migration:show --workspace=@food-delivery/order-service
```

The generated migration files live under each service’s `src/database/migrations` directory. The migration history is tracked in the service database by TypeORM.

### Fresh database initialization

The Postgres container creates the logical service databases through [docker/postgres/init.sql](../docker/postgres/init.sql). That file creates databases such as `auth_service`, `user_service`, `menu_service`, `order_service`, and `payment_service`.

Application tables are created by TypeORM migrations. Do not rely on runtime schema sync. The repository intentionally keeps `synchronize: false` and `migrationsRun: false` for the service TypeORM configuration.

Generated UUID primary keys use PostgreSQL `gen_random_uuid()` from the `pgcrypto` extension. The `001-initial-schema` migrations define this default for fresh databases. The `002-uuid-primary-key-defaults` migrations apply the same default with `ALTER TABLE` for databases where `001` was already applied before the UUID fix. Do not manually assign IDs in API clients or seed scripts.

The generated-ID tables are `credentials`, `restaurants`, `categories`, `menu_items`, `orders`, `order_items`, `payments`, `deliveries`, `drivers`, and `notifications`. `user_profiles.id` is intentionally excluded: it is a `@PrimaryColumn` whose value comes from auth-service.

Verify a repaired database with:

```bash
docker compose exec postgres psql -U postgres -d restaurant_service \
	-c "SELECT column_name, column_default, is_nullable, data_type FROM information_schema.columns WHERE table_name = 'restaurants' AND column_name = 'id';"
```

The expected `column_default` is `gen_random_uuid()`.

### Production migration execution

The Docker image startup path runs the service migration before the Node process starts. This means the production-safe flow is:

1. build the image
2. start the Postgres container
3. let the app container execute its migration
4. start the service only after migration success

This is the intended Docker image startup path and avoids `synchronize: true` creating implicit schema drift. Existing databases still require care: the payment service also contains a manual SQL upgrade under `services/payment-service/migrations/` that is not part of the normal TypeORM migration runner.

### Forward-only expectations and rollback limitations

- migration files are expected to be forward-only once they are published
- do not edit an already-applied migration in a shared environment
- new schema changes must be created as new migration files
- rollback is limited to recovery and local cleanup; it is not the normal deployment path
- schema recovery should be performed with a new migration or a controlled maintenance window, not by re-running `synchronize`

For a disposable local environment, recreate volumes to test the initial schemas from zero:

```bash
docker compose -f docker-compose.base.yml -f docker-compose.dev.yml down -v
docker compose -f docker-compose.base.yml -f docker-compose.dev.yml build --no-cache
docker compose -f docker-compose.base.yml -f docker-compose.dev.yml up -d
```

For an existing local database, keep the volume and rebuild/recreate the affected PostgreSQL-backed service so its `002-uuid-primary-key-defaults` migration runs.

## CI Expectations

CI runs `npm ci`, lint, tests, TypeScript builds, Compose validation, and an API Gateway image build. Trivy scans the filesystem and the built image for unfixed CRITICAL vulnerabilities and secrets. CI does not require production credentials or start the full infrastructure.
