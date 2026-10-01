# Book 11 — NestJS / TypeScript Backend Engineering

[Library index](README.md) · Previous: [Book 10](10-microservices-and-domain-design.md) · Next: [Book 12 — Testing Engineering](12-testing-engineering.md)

**Level:** Junior → Intermediate · **Prerequisites:** TypeScript classes and decorators, [Book 01](01-software-engineering-fundamentals.md).

All twelve backend services are NestJS 10 applications in TypeScript, sharing `@food-delivery/shared` (`shared/src/`). This book explains what NestJS gives you, what it doesn't, and where the framework stops and engineering decisions begin — always through real files.

**Anatomy of one service** (order-service):
```text
services/order-service/src/
├── main.ts                    bootstrap: ValidationPipe, AllExceptionsFilter, Swagger, listen
├── app.module.ts              TypeORM, RedisModule, KafkaModule, CorrelationIdMiddleware
├── config/                    loadConfig() → APP_CONFIG (fail fast on missing env)
├── modules/orders/            feature module wiring
├── controllers/               HTTP routes, guards, DTO validation
├── dto/                       request shapes (class-validator)
├── services/                  business rules, Kafka subscriptions (onModuleInit)
├── repositories/              TypeORM queries
├── entities/                  table mapping
├── common/                    service clients, transition rules, idempotency-key parsing
└── database/                  TypeORM config, data source, migrations
```

---

## Chapter 1 — Modules, providers and dependency injection

### 1. Why this exists
Wiring dozens of collaborators by hand (`new OrdersService(new OrdersRepository(...), new CartServiceClient(...), ...)`) is error-prone and makes testing hard.

### 2. Core concept
- **Module** (`@Module`): a unit that declares `controllers`, `providers`, `imports`, `exports`.
- **Provider**: anything injectable — a class (`@Injectable()`), a value (`useValue`), a factory (`useFactory`), identified by a **token** (class or string/symbol).
- **DI container**: builds the object graph at startup; providers are singletons per module by default.
- **Global modules** (`@Global()`) export providers everywhere without importing.
- **Dynamic modules** (`Module.register(options)`) configure a module at import time.

### 3. Mental model
A module is a box with a public window (`exports`). Nest assembles the boxes at startup and fails loudly if a dependency can't be found.

### 4. Delivery Plus mapping — **CURRENT**
- `RedisModule.register({ url })` (`shared/src/redis/redis.module.ts`) — global dynamic module providing the `REDIS_CLIENT` token via a factory.
- `KafkaModule.register({ clientId, brokers, groupId, durableIdempotency, maxHandlerAttempts })` (`shared/src/kafka/kafka.module.ts`) — conditionally adds `DurableEventIdempotencyService` to providers; `KafkaConsumerService` injects it with `@Optional()`.
- `APP_CONFIG` symbol token for typed configuration (`services/*/src/config/app-config.ts`, `config.module.ts`).

### 5. Example
```ts
// shared/src/kafka/kafka.module.ts (abridged)
static register(options: KafkaModuleOptions): DynamicModule {
  const providers: Provider[] = [{ provide: 'KAFKA_OPTIONS', useValue: options }, KafkaProducerService, KafkaConsumerService];
  if (options.durableIdempotency) providers.push(DurableEventIdempotencyService);
  return { module: KafkaModule, providers, exports: [KafkaProducerService, KafkaConsumerService] };
}
```

### 6. Failure scenario
Enabling `durableIdempotency` in a service that doesn't import `RedisModule`: `DurableEventIdempotencyService` needs `REDIS_CLIENT`, Nest can't resolve it, and the service **fails at startup** — loudly, which is the good outcome. That's why notification-service gained `RedisModule` and `REDIS_URL` when durable idempotency was enabled.

### 7. Trade-offs — DI adds indirection and "magic"; plain factories are explicit but verbose. NestJS's DI is worth it for testability at this size.
### 8. Performance — resolution happens once at boot.
### 9. Security — providers are singletons: never store per-request user data on a provider's fields (use parameters or request-scoped providers).
### 10. Operations — startup failures from DI errors happen at deploy time, not at request time — combine with health checks so a broken release never takes traffic.

### 11. Lab
Comment out `RedisModule.register(...)` in `services/notification-service/src/app.module.ts` locally and start the service (`npm run start:dev --workspace=services/notification-service` with env vars, or rebuild the container). Read the error, then revert.

### 12. Verification
The error names the missing `REDIS_CLIENT` dependency of `DurableEventIdempotencyService`.

### 13. Interview questions
- *Beginner:* What is a provider?
- *Intermediate:* What does `@Optional()` change?
- *Advanced:* Static vs dynamic modules?
- *Senior:* What should live in `shared/` modules vs each service?

### 14. Senior discussion
`RedisModule` is global and creates one client per service. Would you want separate clients (and instances) for cache vs idempotency? How would the module API change?

---

## Chapter 2 — The request pipeline: middleware, guards, pipes, controllers, filters

### 1. Why this exists
Cross-cutting concerns (correlation IDs, authentication, validation, error formatting) must run on every request in the right order.

### 2. Core concept — NestJS order of execution
```text
request
  → middleware (CorrelationIdMiddleware)
  → guards (JwtAuthGuard → RolesGuard → RateLimitGuard)
  → interceptors (before)          [not used here]
  → pipes (ValidationPipe, ParseUUIDPipe)
  → controller method → service → repository
  → interceptors (after)           [not used here]
  → exception filter (AllExceptionsFilter) if anything threw
response
```

### 3. Mental model
Each stage can stop the request. Put the cheapest, most general checks earliest.

### 4. Delivery Plus mapping — **CURRENT**
| Stage | Implementation |
| --- | --- |
| Middleware | `CorrelationIdMiddleware` (`shared/src/nest/middleware/correlation-id.middleware.ts`) — reuse or create `x-correlation-id`, set it on the response |
| Guards | `JwtAuthGuard` (verifies Bearer JWT, sets `request.user`), `RolesGuard` (`@Roles(...)`), `RateLimitGuard` (`@RateLimit(...)`), `InternalAuthGuard` in user-service (HMAC) |
| Pipes | global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` in each `main.ts`; `ParseUUIDPipe` on some params (notifications) |
| Decorators | `@CurrentUser()` (`shared/src/nest/decorators/current-user.decorator.ts`) reads `request.user` |
| Filter | `AllExceptionsFilter` (`shared/src/nest/filters/http-exception.filter.ts`) |

### 5. Example
```ts
// services/order-service/src/controllers/orders.controller.ts (shape)
@Patch(':id/status')
@RateLimit({ limit: 10, windowSeconds: 60 })
updateStatus(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Body() dto: UpdateOrderStatusDto) { … }
```

### 6. Failure scenario
Guard order matters: `RateLimitGuard` keys on `request.user?.sub || request.ip`. If it ran **before** `JwtAuthGuard`, `request.user` wouldn't exist yet and every user would be limited by IP. Also, `@Param('id')` without `ParseUUIDPipe` lets a malformed ID reach PostgreSQL, which fails with a type error → 500 instead of 400.

### 7. Trade-offs — global pipes/filters guarantee consistency; per-route ones allow exceptions but are easy to forget.
### 8. Performance — validation with class-transformer/class-validator costs microseconds per request; fine.
### 9. Security — `forbidNonWhitelisted` rejects unknown fields (mass assignment); `transform` converts types — be careful that transformation doesn't change meaning (e.g. `"1e3"` → 1000).
### 10. Operations — the filter is the single place that shapes every error and logs it with the correlation ID.

### 11. Lab
Send `POST /api/cart/items` with an extra field `{"menuItemId":"…","quantity":1,"price":0}`.

### 12. Verification
You get 400 "property price should not exist" — proof that clients cannot set prices.

### 13. Interview questions
- *Beginner:* Guard vs pipe?
- *Intermediate:* What does `whitelist: true` do?
- *Advanced:* Why does guard order matter for rate limiting?
- *Senior:* Which cross-cutting concerns belong in the gateway instead?

### 14. Senior discussion
No service uses interceptors. Would you add one for request logging and timing (Book 20) or do it in middleware? What does each see?

---

## Chapter 3 — DTOs, validation and configuration

### 1. Why this exists
Untrusted input must be shaped and validated before business logic sees it; configuration must be validated before the service accepts traffic.

### 2. Core concept
- **DTO**: a class describing an input shape, decorated with validation rules and Swagger metadata.
- **Fail-fast configuration**: read env vars once at startup, validate, expose a typed config object.

### 3. Mental model
Validation at the edge means the service layer can trust its inputs' *shape* (not their *authorization*).

### 4. Delivery Plus mapping — **CURRENT**
- DTOs: `services/cart-service/src/dto/add-cart-item.dto.ts` (`@IsUUID`, `@IsInt`, `@Min(1)`), `services/menu-service/src/dto/create-menu-item.dto.ts` (`@IsNumber`, `@IsPositive` price), `services/tracking-service/src/dto/update-location.dto.ts` (`@IsLatitude`, `@IsLongitude`).
- Config: `loadConfig()` in each service throws `Missing required environment variables: …` (e.g. `DATABASE_URL`, `JWT_SECRET`); auth-service parses positive integers for lockout settings (`parsePositiveInt` in `services/auth-service/src/config/app-config.ts`).
- Gateway refuses to start in production without `CORS_ORIGINS`.

### 5. Example — the tracking DTO rejects `latitude: 123` with 400 before the service runs.
### 6. Failure scenario — a config value with a silent default in production (e.g. `JWT_SECRET` defaulting to a dev string) — Delivery Plus requires it explicitly, and the prod Compose overlay uses `${JWT_SECRET:?…}`.
### 7. Trade-offs — decorators are concise but scatter rules across classes; schema libraries (zod) centralise them. NestJS ecosystem favours class-validator.
### 8. Performance — negligible.
### 9. Security — validate lengths of strings (names, search terms) to bound memory and query cost.
### 10. Operations — fail-fast config turns a misconfigured deploy into an immediate crash loop instead of a half-working service.

### 11. Lab
Start a service without `JWT_SECRET` (`dc run --rm -e JWT_SECRET= order-service`) and observe the startup error.

### 12. Verification
The container exits with the missing-variable message instead of serving requests.

### 13. Interview questions
- *Beginner:* What is a DTO?
- *Intermediate:* Why validate config at startup?
- *Advanced:* What validation belongs in DTOs vs services?
- *Senior:* How do you manage config for 12 services across 4 environments?

### 14. Senior discussion
Validation rules (quantity ≥ 1, price > 0) exist only in DTOs, not as database constraints. Should they be in both?

---

## Chapter 4 — Domain services, repositories, adapters and service clients

### 1. Why this exists
Business rules must be testable without HTTP, SQL or Kafka.

### 2. Core concept
- **Domain service**: business rules and orchestration.
- **Repository**: persistence behind an intention-revealing API (`updateStatus(id, from, to)`, not `query(sql)`).
- **Adapter / client**: translates between your model and an external system (another service, S3, Kafka).
- **Error mapping**: remote errors become local typed errors.

### 3. Mental model
Ports and adapters (hexagonal architecture), lightly applied: services depend on repositories and clients; repositories and clients depend on TypeORM, `fetch`, kafkajs.

### 4. Delivery Plus mapping — **CURRENT**
- Repository with intention-revealing CAS: `DeliveriesRepository.transition(id, from, data)`.
- Service clients with input validation and error mapping: `services/delivery-service/src/common/driver-service.client.ts` — `assertValidUuidV4` before building URLs, 404 → `NotFoundError`, 409 → `DriverStatusRejectedError`, idempotent `releaseDriver`.
- Adapter for object storage: `S3StorageService` (`shared/src/storage/s3-storage.service.ts`).

### 5. Example — `OrderServiceClient.assertReadableBy` (delivery-service) maps 401/403 from order-service into `ForbiddenError` so the caller gets a clean 403.
### 6. Failure scenario — leaking transport details upward: a service method that inspects raw `fetch` responses spreads HTTP knowledge through business code and makes retries inconsistent.
### 7. Trade-offs — thin clients (current, plain `fetch`) are transparent; a shared HTTP client (issue #6) would centralise timeouts, retries and correlation headers.
### 8. Performance — see [Book 21](21-performance-engineering.md) for connection reuse with `fetch` (undici keeps connections alive by default).
### 9. Security — every client validates IDs before interpolating them into URLs (prevents path traversal / SSRF-style abuse of internal calls).
### 10. Operations — clients are where timeouts, retries and metrics should live.

### 11. Lab
Write a unit test (locally) for `DriverServiceClient.releaseDriver` that mocks `fetch` to return 409 and then a BUSY driver. Compare with the existing tests in `services/delivery-service/src/common/driver-service.client.spec.ts`.

### 12. Verification
Your test expects a rejection; flipping the mocked status to `AVAILABLE` makes it resolve.

### 13. Interview questions
- *Beginner:* What does a repository do?
- *Intermediate:* Why validate an ID before building a URL?
- *Advanced:* How should a client map 5xx vs 4xx from another service?
- *Senior:* Design a shared HTTP client for all services (issue #6).

### 14. Senior discussion
Is TypeORM's repository plus a custom repository class two layers of the same thing? When would you drop one?

---

## Chapter 5 — Lifecycle hooks, logging and graceful shutdown

### 1. Why this exists
Services start Kafka consumers, open connections and must stop cleanly during deploys.

### 2. Core concept
- Hooks: `onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`, `beforeApplicationShutdown`, `onApplicationShutdown`.
- `app.enableShutdownHooks()` makes Nest call the destroy/shutdown hooks on `SIGTERM`/`SIGINT`.
- Structured logging: JSON lines with level, service, message and context.

### 3. Mental model
```text
SIGTERM → stop accepting HTTP → stop polling Kafka → finish in-flight work → commit offsets → close DB/Redis/Kafka → exit 0
```

### 4. Delivery Plus mapping
- **CURRENT:** Kafka subscriptions start in `onModuleInit` (`OrdersService`, `NotificationsService`); `KafkaConsumerService`/`KafkaProducerService` disconnect in `onModuleDestroy`.
- **NOT IMPLEMENTED:** `enableShutdownHooks()` is not called in any `main.ts`, so `onModuleDestroy` never runs on `SIGTERM`; containers are killed after Docker's grace period and consumers linger in their group until the session times out (issue #7).
- **CURRENT, inconsistent:** `createServiceLogger` (Winston JSON, `shared/src/logging/logger.ts`) is used for startup and errors; classes like `KafkaConsumerService` use Nest's `Logger`, which prints plain text. `bufferLogs: true` is set but the Winston logger is never installed with `app.useLogger`, so two formats coexist.

### 5. Example — the minimal fix (FUTURE):
```ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });
app.useLogger(nestCompatibleWinstonLogger);  // one format everywhere
app.enableShutdownHooks();                   // run onModuleDestroy on SIGTERM
```

### 6. Failure scenario — a deploy stops notification-service mid-handler; no shutdown hook runs; the event is redelivered to the new instance after the session timeout; durable idempotency sees a live or expired lease and waits or re-processes ([Book 08](08-idempotency-and-distributed-operations.md)).
### 7. Trade-offs — graceful shutdown needs a deadline (otherwise a stuck handler blocks the deploy forever).
### 8. Performance — n/a.
### 9. Security — logs must never contain tokens or passwords; the filter logs messages, not request bodies.
### 10. Operations — consistent JSON logs are a prerequisite for log search and alerting ([Book 20](20-observability.md)).

### 11. Lab
[OPS-03 Graceful shutdown](labs/devops-labs.md#ops-03-graceful-shutdown).

### 12. Verification
`dc stop notification-service` takes ~10 s (Docker's default grace) and the group remains `Stable` for ~30 s afterwards — evidence that shutdown is not graceful.

### 13. Interview questions
- *Beginner:* What does `onModuleInit` do?
- *Intermediate:* Why call `enableShutdownHooks()`?
- *Advanced:* Order of shutdown for HTTP, Kafka, DB?
- *Senior:* Design graceful shutdown with deadlines for all services (issue #7).

### 14. Senior discussion
Should the Kafka consumer start in `onModuleInit` (before the HTTP server listens) or after the app is ready? What happens to health checks during startup?

---

## Chapter 6 — Testing NestJS code

### 1. Why this exists
Fast, focused tests catch logic errors before slow end-to-end runs.

### 2. Core concept
- Unit tests construct a class directly with fakes/mocks (fast, no Nest container).
- `@nestjs/testing` `Test.createTestingModule` builds a partial container (guards, pipes, metadata).
- Controller specs can assert **guard metadata** (which roles a route requires).

### 3. Mental model
Test business rules as plain classes; test framework wiring (guards, decorators) with a thin module or metadata checks.

### 4. Delivery Plus mapping — **CURRENT**
- Service specs construct services directly: `services/delivery-service/src/services/deliveries.service.spec.ts`, `services/order-service/src/services/orders.service.spec.ts`.
- Controller/guard specs: `services/driver-service/src/controllers/drivers.controller.spec.ts`, `services/notification-service/src/controllers/notifications.controller.spec.ts`.
- Shared infrastructure specs: `shared/src/kafka/kafka-consumer.service.spec.ts` (mocks kafkajs), `shared/src/redis/rate-limit.guard.spec.ts`, `shared/src/kafka/durable-event-idempotency.service.spec.ts` (fake Redis, and real Redis when `REDIS_TEST_URL` is set in CI).
- More in [Book 12](12-testing-engineering.md).

### 5. Example — `deliveries.service.spec.ts` contains "retry safety: the driver is always released" tests: driver-service down → retry releases; order-service down → driver still released first.
### 6. Failure scenario — mocks that don't match reality (a mocked repository returning a value where the real CAS returns `null`) give green tests for broken code. Back unit tests with integration and E2E tests.
### 7. Trade-offs — direct construction is fast and explicit; full testing modules catch wiring bugs but are slower.
### 8. Performance — ~400 backend unit tests run in well under a minute per workspace.
### 9. Security — test authorization *negatively*: every role that must be refused gets a test.
### 10. Operations — tests are part of the PR gate (`.github/workflows/pr-quality.yml`).

### 11. Lab
Run `npm test --workspace=services/delivery-service` and then break `advance()` (remove the "already at target" branch). Run again.

### 12. Verification
The retry-safety tests fail with a clear message; restoring the code makes them pass.

### 13. Interview questions
- *Beginner:* What is a mock?
- *Intermediate:* How do you test that a route requires ADMIN?
- *Advanced:* When is a NestJS testing module worth its cost?
- *Senior:* How do you keep mocks honest?

### 14. Senior discussion
NestJS solves wiring, validation, and request pipelines. It does **not** solve timeouts, retries, idempotency, consistency, observability or graceful degradation. Which of those would you standardise in `shared/` next, and in what order?

---

[Library index](README.md) · Previous: [Book 10](10-microservices-and-domain-design.md) · Next: [Book 12 — Testing Engineering](12-testing-engineering.md)
