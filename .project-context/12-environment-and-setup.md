# Environment and Setup

## Local run model

This project is intended to run with a Docker Compose-based local stack for infrastructure and all application services. The main orchestration file is:

- [docker-compose.yml](../docker-compose.yml)

## Toolchain

Use Node.js 22 (at least 22.15; `http-proxy-middleware` 4 refuses older engines) with npm, and Docker with Compose v2. CI and the Dockerfile both use Node 22. Install with `npm ci` from the repository root so every workspace gets exactly the lockfile's versions.

## Required infrastructure

The stack expects the following runtime dependencies:

- PostgreSQL
- Redis
- Zookeeper
- Kafka
- S3-compatible object storage (the dev/test overlays start SeaweedFS as `media-storage`)
- multiple NestJS application services

These are all defined in the compose file and are expected to start in dependency order using health checks.

## Core environment variables

Common runtime values include:

- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`, `AWS_S3_ENDPOINT`, `AWS_S3_PUBLIC_ENDPOINT`, `AWS_PUBLIC_BASE_URL`, and `AWS_S3_FORCE_PATH_STYLE` for media storage
- service-specific URLs such as `AUTH_SERVICE_URL`, `ORDER_SERVICE_URL`, and `KAFKA_BROKER`

The compose file sets practical local defaults, including a development JWT secret and default Postgres credentials.

Test-only variables (unset by default, so `npm test` needs no infrastructure):

- `REDIS_TEST_URL`: also run the shared durable-idempotency tests against this Redis, e.g. `redis://localhost:6379`
- `PAYMENT_TEST_DATABASE_URL`: run the payment-service repository integration test against a disposable Postgres database

The dev/test Compose overlays supply local defaults (`minioadmin` credentials, `us-east-1`, bucket `delivery-plus-media`, internal endpoint `http://media-storage:9000`, and public endpoint/base URL on `localhost:9000`) for a `media-storage` service running SeaweedFS's S3 gateway (see [15-media-and-storage.md](15-media-and-storage.md) for why this isn't MinIO). The production overlay requires a bucket, public/CDN base URL, and credentials through deployment environment variables; do not reuse local credentials. `AWS_S3_PUBLIC_ENDPOINT` is for signing browser-reachable URLs, while `AWS_S3_ENDPOINT` is for service-to-object-storage requests.

## Database conventions

Each service configures a `DATABASE_URL` pointing to the same Postgres instance but a different logical database name, such as:

- `auth_service`
- `user_service`
- `restaurant_service`
- `menu_service`
- `order_service`
- `payment_service`
- `delivery_service`
- `driver_service`
- `notification_service`

This keeps service data isolated while sharing the same infrastructure environment.

## Typical local workflow

A practical developer flow is:

1. install Node dependencies from the workspace root
2. run the stack with Docker Compose
3. confirm service health routes, including the gateway's `http://localhost:3000/health`
4. use the gateway on port `3000`
5. inspect Kafka on `localhost:8085` via Kafka UI if needed

## Service URL conventions

The system assumes internal service-to-service access names like:

- `http://auth-service:3001`
- `http://order-service:3006`
- `http://delivery-service:3008`
- `http://kafka:29092`

These names are used inside Docker networking and are not necessarily meant to be called directly from the host machine.

## Port map summary

| Purpose | Port |
| --- | ---: |
| API Gateway | 3000 |
| Auth Service | 3001 |
| User Service | 3002 |
| Restaurant Service | 3003 |
| Menu Service | 3004 |
| Cart Service | 3005 |
| Order Service | 3006 |
| Payment Service | 3007 |
| Delivery Service | 3008 |
| Driver Service | 3009 |
| Tracking Service | 3010 |
| Notification Service | 3011 |
| PostgreSQL | 5432 |
| Redis | 6379 |
| Kafka | 9092 |
| Kafka UI | 8085 |
| S3 API (`media-storage`, dev/test only) | 9000 |

## Notes for contributors

- service URLs and ports are defined centrally in compose, not hidden in code
- stack startup is configuration-driven, but health routes are liveness checks, not full dependency readiness
- local defaults are suitable for development, not for production credentials or security settings

## Source of truth

- Compose setup: [docker-compose.yml](../docker-compose.yml)
- Root package scripts: [package.json](../package.json)
- Container build: [Dockerfile](../Dockerfile)
