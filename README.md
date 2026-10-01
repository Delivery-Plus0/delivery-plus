<p align="center">
  <img src="./assets/logo.png" alt="Delivery Plus" width="420">
</p>

<h3 align="center">A cloud-native, event-driven microservices platform for on-demand delivery</h3>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-red.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-22-red.svg" alt="Node 22">
  <img src="https://img.shields.io/badge/NestJS-10-red.svg?logo=nestjs&logoColor=white" alt="NestJS 10">
  <img src="https://img.shields.io/badge/TypeScript-5-red.svg?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Docker-ready-red.svg?logo=docker&logoColor=white" alt="Docker Ready">
  <img src="https://img.shields.io/badge/PostgreSQL-16-red.svg?logo=postgresql&logoColor=white" alt="PostgreSQL 16">
  <img src="https://img.shields.io/badge/Redis-cache-red.svg?logo=redis&logoColor=white" alt="Redis">
  <img src="https://img.shields.io/badge/Kafka-events-red.svg?logo=apachekafka&logoColor=white" alt="Kafka">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/PRs-welcome-red.svg" alt="PRs Welcome">
  <img src="https://img.shields.io/badge/open%20source-yes-red.svg" alt="Open Source">
  <img src="https://img.shields.io/badge/build-passing-brightgreen.svg" alt="Build Passing">
  <img src="https://img.shields.io/badge/code%20style-eslint-red.svg" alt="Code Style: ESLint">
  <img src="https://img.shields.io/badge/tests-jest-red.svg?logo=jest&logoColor=white" alt="Tests: Jest (workspace tests)">
</p>

<p align="center">
  <a href="#-architecture">Architecture</a> ·
  <a href="#-tech-stack">Tech Stack</a> ·
  <a href="#-services">Services</a> ·
  <a href="#-getting-started">Getting Started</a> ·
  <a href="#-testing">Testing</a> ·
  <a href="#-contributing">Contributing</a> ·
  <a href="#-license">License</a>
</p>

---

## <img src="./assets/icons/overview.png" width="26" valign="middle"> Overview

**Delivery Plus** is a backend food-delivery platform built as independently deployable **microservices** that communicate over REST and **Kafka** events. Domain responsibilities are separated across auth, users, restaurants, menus, carts, orders, payments, drivers, deliveries, tracking, and notifications. PostgreSQL-backed services own relational data; cart and tracking use Redis; images live in S3-compatible object storage, uploaded directly by clients through presigned POST policies; the gateway owns no domain data.

For a one-page status of what is implemented, partial, or missing today, see [`.project-context/16-current-state.md`](./.project-context/16-current-state.md).

This is a **backend-only** repository — no frontend/UI is included here by design. It's meant to be consumed by web, mobile, or third-party clients through the **API Gateway**.

## <img src="./assets/icons/architecture.png" width="26" valign="middle"> Architecture

```mermaid
flowchart LR
    Client[Client Apps] --> GW[API Gateway]

    GW --> AUTH[Auth Service]
    GW --> USER[User Service]
    GW --> REST[Restaurant Service]
    GW --> MENU[Menu Service]
    GW --> CART[Cart Service]
    GW --> ORD[Order Service]
    GW --> PAY[Payment Service]
    GW --> DEL[Delivery Service]
    GW --> DRV[Driver Service]
    GW --> TRK[Tracking Service]
    GW --> NOTIF[Notification Service]

    AUTH --> USER
    USER --> ORD
    MENU --> REST
    CART --> MENU
    ORD --> CART
    ORD --> REST
    PAY --> ORD
    DEL --> ORD
    DEL --> DRV
    TRK --> DEL
    TRK --> DRV

    ORD -.->|order.events| KAFKA[(Kafka)]
    PAY -.->|payment.events| KAFKA
    DEL -.->|delivery.events| KAFKA

    KAFKA -.->|payment + delivery events| ORD
    KAFKA -.->|order, payment, delivery events| NOTIF

    CART -.->|carts| REDIS[(Redis)]
    TRK -.->|live location| REDIS

    USER -.->|avatars| S3[(S3-compatible storage)]
    REST -.->|images| S3
    MENU -.->|images| S3

    AUTH --> PG[(PostgreSQL)]
    USER --> PG
    REST --> PG
    MENU --> PG
    ORD --> PG
    PAY --> PG
    DRV --> PG
    DEL --> PG
    NOTIF --> PG
```

Every service is self-contained and shares a common foundation through the internal `shared` library. The shared package provides enums, transition helpers, Kafka/Redis helpers, S3 media storage, internal service authentication, JWT and role guards, logging, and common NestJS utilities. Redis is also used for caching, rate limits, and internal-auth nonces, which the diagram omits for readability. Kafka consumers deduplicate events per consumer group in Redis, retry a failing handler three times, then park the message in a `<topic>.dlq` dead-letter topic that `npm run kafka:dlq` can list and replay; events are keyed by `orderId`. There is no transactional outbox yet.

## <img src="./assets/icons/tech_stack.png" width="26" valign="middle"> Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22 LTS |
| Language | TypeScript 5 |
| Framework | NestJS 10 |
| Database | PostgreSQL 16 |
| Cache / Real-time state | Redis 7 |
| Messaging / Events | Apache Kafka |
| Media storage | S3-compatible object storage (SeaweedFS in local dev/test) |
| Containerization | Docker & Docker Compose |
| Testing | Jest (unit + e2e) |
| Shared internals | Custom `shared` package (events, guards, filters, utils) |

## <img src="./assets/icons/services.png" width="26" valign="middle"> Services

| Service | Responsibility |
|---|---|
| `api-gateway` | Single entry point, request routing to downstream services |
| `auth-service` | Authentication, credentials, JWT issuing |
| `user-service` | User profiles |
| `restaurant-service` | Restaurant records & status |
| `menu-service` | Menu categories & items, availability |
| `cart-service` | Shopping cart (Redis-backed) |
| `order-service` | Order lifecycle & orchestration |
| `payment-service` | Payment processing |
| `driver-service` | Driver registration & status transitions |
| `delivery-service` | Delivery lifecycle |
| `tracking-service` | Live location tracking (Redis-backed) |
| `notification-service` | User notifications |

Every service, including the API Gateway, exposes a `/health` route used by Compose healthchecks. These are liveness checks; they do not prove that Kafka, Redis, or downstream services are reachable. Services generally follow `controllers → services → repositories/entities`, with variations by service.

## <img src="./assets/icons/getting_started.png" width="26" valign="middle"> Getting Started

### Prerequisites
- Node.js 22 (22.15 or newer)
- Docker & Docker Compose

### Run locally

```bash
# clone the repo
git clone https://github.com/<your-org>/delivery-plus.git
cd delivery-plus

# install dependencies
npm install

# local dev stack: shared infra + application services; --wait blocks until
# Compose healthchecks pass, including services after their migrations run
docker compose -f docker-compose.base.yml -f docker-compose.dev.yml up -d --build --wait --wait-timeout 300

# bootstrap sample data through the API Gateway and run the critical path
npm run seed
npm run e2e
```

For environment-specific validation:

```bash
# deterministic test layout
docker compose -f docker-compose.base.yml -f docker-compose.test.yml config --quiet

# production-like validation (requires secrets explicitly)
# These values are for Compose configuration validation only and must never be used for deployment.
export POSTGRES_USER="compose_validation_user"
export POSTGRES_PASSWORD="compose_validation_only_7f3c2b"
export POSTGRES_USER_URLENCODED="compose_validation_user"
export POSTGRES_PASSWORD_URLENCODED="compose_validation_only_7f3c2b"
export JWT_SECRET="compose_validation_only_jwt_9a41d8"
docker compose -f docker-compose.base.yml -f docker-compose.prod.yml config --quiet
```

```powershell
# PowerShell equivalent
$env:POSTGRES_USER="compose_validation_user"
$env:POSTGRES_PASSWORD="compose_validation_only_7f3c2b"
$env:POSTGRES_USER_URLENCODED="compose_validation_user"
$env:POSTGRES_PASSWORD_URLENCODED="compose_validation_only_7f3c2b"
$env:JWT_SECRET="compose_validation_only_jwt_9a41d8"
docker compose -f docker-compose.base.yml -f docker-compose.prod.yml config --quiet
```

### API documentation

Each HTTP service exposes Swagger UI at `http://localhost:<service-port>/docs`, and the API Gateway aggregates the service docs at `http://localhost:3000/docs`.

The API Gateway will be available at `http://localhost:3000`; see [`docs/deployment.md`](./docs/deployment.md) for the Compose variants, ports, and environment configuration. `npm run seed` bootstraps the sample environment through the API Gateway only. It is safe to rerun: existing accounts and catalog records are reused, while each run creates a new order/payment/delivery scenario. `npm run e2e` assumes the seed has completed successfully. For manual testing of the customer app, `npm run seed:demo` adds a richer catalog (6 restaurants across OPEN/BUSY/CLOSED, categorized menus with sold-out items, cover and avatar images) and a demo customer (`demo.customer@example.com` / `password123`) with a profile, a filled cart, notifications, and orders in delivered, cancelled, failed-payment, preparing, and on-the-way states. It is also rerunnable and does not interfere with `npm run seed` / `npm run e2e`.

## <img src="./assets/icons/testing.png" width="26" valign="middle"> Testing

```bash
# unit tests for a given service
npm run test --workspace=services/order-service

# complete repository validation used by CI
npm run verify

# API-level local bootstrap and critical-path validation
npm run seed
npm run e2e
```

`npm run verify` runs workspace lint, tests, and builds. CI also validates Compose syntax, builds the API Gateway image, and runs Trivy filesystem and image scans. It does not start the full stack or run the E2E script.

## <img src="./assets/icons/docs.png" width="26" valign="middle"> Documentation

- [`docs/architecture.md`](./docs/architecture.md) — deep dive into service boundaries & event flows
- [`docs/deployment.md`](./docs/deployment.md) — environment variables, ports, deployment guide
- [`docs/services.md`](./docs/services.md) — per-service API reference

## <img src="./assets/icons/contributing.png" width="26" valign="middle"> Contributing

Contributions are what make open source great. Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) and our [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) before opening a PR.

1. Fork the repo
2. Create your branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

Found a security issue? Please follow the process in [`SECURITY.md`](./SECURITY.md) instead of opening a public issue.

## <img src="./assets/icons/license.png" width="26" valign="middle"> License

Distributed under the **MIT License**. See [`LICENSE`](./LICENSE) for details.

---

<p align="center">
  <img src="./assets/icon.png" width="20" valign="middle">
  Made by the Delivery Plus team
</p>