# Code-Reading Guide

[Library index](README.md) · [Checkpoints](checkpoints.md)

How to find your way around Delivery Plus. Read the tour once, then follow the request paths with the code open. Backend paths are relative to the `delivery-plus` root; customer-app paths start with `delivery-plus-customer-app/`.

---

## How a service is laid out

Every NestJS service under `services/<name>/src/` follows the same shape:

| Folder / file | Holds | Read it when… |
| --- | --- | --- |
| `main.ts` | bootstrap: global pipes, filters, Swagger, port | you need startup behaviour |
| `app.module.ts` | which shared modules are wired (Kafka, Redis, TypeORM) and their options | you ask "does this service use X?" |
| `controllers/` | routes, guards, decorators, DTO binding | you start from a URL |
| `dto/` | request validation (`class-validator`) | you ask "what input is accepted?" |
| `services/` | business rules, state transitions, calls to other services, event publishing | almost always |
| `repositories/` | database or Redis access | you ask "what query runs?" |
| `entities/` | TypeORM entities / Redis models | schema questions |
| `database/migrations/` | schema history | "when did this column appear?" |
| `common/` | HTTP clients to other services, system tokens, small helpers | cross-service calls |
| `config/` | env parsing with defaults | "what's the default for X?" |
| `*.spec.ts` next to the code | unit tests | the fastest way to learn intended behaviour |

The **shared library** (`shared/src/`) holds:
- `kafka/` — producer, consumer, idempotency, DLQ;
- `redis/` — cache, rate limiter, guard;
- `nest/auth/` — JWT guard, roles, internal HMAC auth;
- `events/` — contracts and event identity;
- `types/enums.ts` — statuses and transition tables;
- `storage/` — S3;
- errors, filters and correlation IDs.

**Tip:** read `shared/src/types/enums.ts` first. The transition tables are the business rules in their most compact form.

---

## Starting points

| Question | Open |
| --- | --- |
| What routes exist and who can call them? | `docs/openapi/delivery-plus-public.json`, `services/api-gateway/src/route-policy.ts`, the controllers |
| How does the gateway route? | `services/api-gateway/src/main.ts` |
| What runs where, on which ports? | `docker-compose.base.yml`, `docker-compose.dev.yml` |
| Which databases exist? | `docker/postgres/init.sql` |
| What's the architecture in prose? | `docs/architecture.md`, `docs/services/` |
| What's known-broken or planned? | `issues/`, the GitHub milestones ([Book 28](28-architecture-evolution.md)) |

---

## Order creation

`POST /api/orders` with an `Idempotency-Key` header. **CURRENT.**

1. **Customer app:**
   - `delivery-plus-customer-app/src/app/(app)/checkout.tsx` calls `submitCheckout` (`src/services/checkout.ts`), which runs `createOrder` → `createPayment` → `processPayment`, each with its own idempotency key.
   - The HTTP client is `src/services/api.ts`: timeout, auth header, error mapping.
2. **Gateway:** `services/api-gateway/src/main.ts` proxies `/api/orders` to order-service.
3. **Controller:** `services/order-service/src/controllers/orders.controller.ts` (guards: JWT + role) parses the key (`common/idempotency-key.ts`) and calls `createFromCart(user.sub, authHeader, key)`.
4. **Service:** `services/order-service/src/services/orders.service.ts` → `createFromCart`. In order:
   - a prior order with the same key → return it;
   - read the cart from cart-service **with the customer's token** (`common/cart-service.client.ts`);
   - check the restaurant is OPEN (`common/restaurant-service.client.ts`);
   - insert the order and items (`repositories/orders.repository.ts`);
   - clear the cart;
   - publish `order.created` with a deterministic ID (`lifecycleEventId`).

   A unique-key race is resolved by re-reading the winner.
5. **Data:** `entities/order.entity.ts`, `entities/order-item.entity.ts`. The idempotency key has a partial unique index.
6. **Consumers of `order.created`:** notification-service (`services/notification-service/src/services/notifications.service.ts`).

Hops for this one request: app → gateway → order-service → cart-service (read) → restaurant-service → PostgreSQL → cart-service (clear) → Kafka. Item names and prices come from the cart, copied in when items were added, so checkout does not call menu-service. Gaps: publish after commit with no outbox ([case study 13](case-studies/13-transactional-outbox.md)).

---

## Payment

`POST /api/payments` (create, idempotent) → `POST /api/payments/:id/process`. **CURRENT (simulated provider).**

1. `services/payment-service/src/controllers/payments.controller.ts`
2. `services/payment-service/src/services/payments.service.ts`:
   - `createPayment` checks the order belongs to the caller and is payable, and dedupes on the idempotency key.
   - `processPayment` runs a CAS transition PENDING → PROCESSING → COMPLETED / FAILED (`Math.random() < PAYMENT_SUCCESS_RATE`).
   - `completeSideEffects`: under a lease, publish the `payment.*` event if not yet published, then `syncOrder` if not yet synced; the markers are `publishedEventStatus` and `orderSyncedStatus`.
   - `refund` is ADMIN-only.
3. `services/payment-service/src/common/order-service.client.ts`: the HTTP sync with a system token (`common/system-token.service.ts`).
4. order-service consumes `payment.*` (`OrdersService.onModuleInit` → `syncStatusFromEvent`).

Read with: [case study 01](case-studies/01-failed-payment-race.md), [ADR 0008](adrs/0008-payment-state-ownership.md), [Book 25](25-payment-systems.md).

---

## Kafka

**CURRENT.**

| Step | File |
| --- | --- |
| topic names | `shared/src/events/topics.ts` |
| event contracts | `shared/src/events/order-events.ts`, `payment-events.ts`, `delivery-events.ts`, `base-event.ts` |
| event IDs and partition key | `shared/src/events/event-identity.ts` |
| producing | `shared/src/kafka/kafka-producer.service.ts` |
| consuming, retries, DLQ | `shared/src/kafka/kafka-consumer.service.ts` |
| durable idempotency | `shared/src/kafka/durable-event-idempotency.service.ts`, `durable-event-idempotency.scripts.ts` |
| wiring per service | `services/*/src/app.module.ts` (`KafkaModule.register`) |
| DLQ inspect and replay | `scripts/kafka-dlq.ts` (`npm run kafka:dlq`) |
| operations | `docs/deployment.md` (topics, retention), `docs/runbooks/local-stack-troubleshooting.md` |

**Reading order:** the contracts → the producer → the consumer's message handling path (claim → handler with retries → mark processed or DLQ → commit) → one subscriber (`OrdersService.onModuleInit`).

---

## Delivery and tracking

**CURRENT** (manual dispatch); automatic dispatch **PLANNED**.

1. `services/delivery-service/src/controllers/deliveries.controller.ts`: create, assign, pickup, start, complete, cancel, `by-order`.
2. `services/delivery-service/src/services/deliveries.service.ts`:
   - `assignDriver`: claim a driver, CAS, give back on failure;
   - `advance`: CAS, plus retry re-runs the side effects;
   - `releaseDriverOf`, `syncOrderAlongDelivery`, `publishEvent`;
   - `assertCanRead` and `assertCanDispatch`: ownership through order-service.
3. `services/driver-service/src/services/drivers.service.ts`, `repositories/drivers.repository.ts`: status transitions; `findAvailable` (most recently updated).
4. `services/tracking-service/src/services/tracking.service.ts`, `repositories/location.repository.ts`: `driver:location:{userId}` with a TTL; customer reads go through delivery ownership.

Read with: case studies [02](case-studies/02-delivery-ownership-bug.md), [08](case-studies/08-delivery-lifecycle-events.md), [09](case-studies/09-driver-availability-lifecycle.md), [19](case-studies/19-driver-dispatch.md).

---

## Customer app

**CURRENT.** Expo Router, React Native, web build for E2E.

| Concern | File |
| --- | --- |
| screens (routes) | `delivery-plus-customer-app/src/app/` (`(auth)`, `(app)/(tabs)`, `(app)/order/[id].tsx`, `checkout.tsx`, `cart.tsx`) |
| HTTP client | `delivery-plus-customer-app/src/services/api.ts` |
| session / token storage | `delivery-plus-customer-app/src/services/session.ts` |
| data fetching + polling | `delivery-plus-customer-app/src/hooks/use-resource.ts`, `src/state/resource-cache.ts` |
| order and delivery polling | `delivery-plus-customer-app/src/state/orders.ts`, `src/state/deliveries.ts` |
| checkout | `delivery-plus-customer-app/src/services/checkout.ts` |
| E2E flows and runner | `delivery-plus-customer-app/e2e/flows/`, `e2e/scripts/run.mjs` |

**Reading order:** `api.ts` → `use-resource.ts` → `state/orders.ts` → `app/(app)/order/[id].tsx` → the matching Maestro flow.

---

## Habits that make reading faster

- **Start from a test.** `*.spec.ts` names describe intended behaviour in plain language.
- **Search by status or event name.** `grep -rn "DRIVER_ASSIGNED" services shared` shows every place a transition matters.
- **Follow the token.** `@Headers('authorization')` means the caller's token is forwarded; `SystemTokenService` means the service acts as ADMIN.
- **Check git history for the why.** `git log --oneline -- <file>`, then `git show <sha>`. Commit messages in this repository explain the reasoning.
- **Trust the code over the docs**, including this library. If they disagree, the code wins. Open an issue for the doc.
