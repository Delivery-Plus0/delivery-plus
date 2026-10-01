# Book 01 — Software Engineering Fundamentals

[Library index](README.md) · Previous: [Book 00](00-how-to-use-this-curriculum.md) · Next: [Book 02 — Data Structures & Algorithms](02-data-structures-and-algorithms.md)

**Level:** Junior → Intermediate · **Prerequisites:** you can read TypeScript and write functions and classes.

This book is about the habits that make code safe to change. Every concept is shown in Delivery Plus code you can open, including places where the code is good and places where it is not.

---

## Chapter 1 — Cohesion, coupling and separation of concerns

### 1. Why this exists
Code is read and changed far more often than it is written. When one change forces edits in ten unrelated places, or one file mixes HTTP parsing, SQL, business rules and Kafka publishing, every change becomes risky. Cohesion and coupling are the two words engineers use to describe that risk.

### 2. Core concept
- **Cohesion**: how strongly the things inside one module belong together. High cohesion = one reason to change.
- **Coupling**: how much one module must know about another to work. Low coupling = you can change one without touching the other.
- **Separation of concerns**: put different *kinds* of decisions (transport, business rules, persistence, integration) in different places.

### 3. Mental model
Think of each layer as answering exactly one question:

```text
Controller  →  "What did the caller ask for, and is the request well-formed?"
Service     →  "Is this allowed, and what should change?"
Repository  →  "How is it stored and read?"
Client      →  "How do I talk to another service?"
Producer    →  "How do I tell the rest of the system that it changed?"
```

If you can't say which question a line of code answers, it is probably in the wrong place.

### 4. Delivery Plus mapping — **CURRENT**
Every service follows the same layering:

| Layer | Example |
| --- | --- |
| Controller (HTTP, guards, DTO validation) | `services/order-service/src/controllers/orders.controller.ts` |
| Service (business rules) | `services/order-service/src/services/orders.service.ts` |
| Repository (TypeORM queries) | `services/order-service/src/repositories/orders.repository.ts` |
| Entity (table shape) | `services/order-service/src/entities/order.entity.ts` |
| Client (other services over HTTP) | `services/order-service/src/common/cart-service.client.ts`, `restaurant-service.client.ts` |
| Rules as data | `services/order-service/src/common/order-transition-rules.ts` |

The transition rules are a good example of high cohesion: "who may move an order to which status" lives in one small file (`TRANSITION_ROLES`), and the allowed status graph lives in one shared constant (`ORDER_TRANSITIONS` in `shared/src/types/enums.ts`).

### 5. Example
`OrdersRepository.updateStatus(id, from, to)` knows SQL but nothing about roles. `OrdersService.updateStatus(...)` knows roles, ownership and which event to publish, but writes no SQL. You can change the compare-and-set SQL without touching authorization, and change authorization without touching SQL.

### 6. Failure scenario
Imagine the status update were written inside the controller: check the role, run `UPDATE orders SET status = ...`, publish to Kafka. Now the payment-event consumer (in `onModuleInit` of `OrdersService`) needs the same logic. Copy-paste produces two versions; one gets a bug fix, the other doesn't. That is exactly the kind of divergence that caused the failed-payment race in this project — two writers (HTTP sync and Kafka consumer) applying the *same* transition with *different* rules. See [case study 01](case-studies/01-failed-payment-race.md).

### 7. Trade-offs
More layers mean more files and indirection. For a 30-line script, layering is waste. The rule of thumb: layer when a decision is reused, tested independently, or likely to change for a different reason.

### 8. Performance
Layering itself is free at runtime (a few function calls). The performance risk is *hidden I/O*: a "simple" service method that calls three repositories and two remote services. Make I/O visible in names (`fetch…`, `…Client`).

### 9. Security
Authorization belongs in one layer. In Delivery Plus, roles are checked by `RolesGuard` at the controller and *ownership* is checked in the service (for example `DeliveriesService.assertCanRead`). Splitting "role" and "ownership" is fine; forgetting one of them is the classic IDOR bug ([case study 02](case-studies/02-delivery-ownership-bug.md)).

### 10. Operations
Clear layers make logs meaningful: an error from a `…Client` is a dependency problem, an `InvalidStateTransitionError` from a service is a business rule, a TypeORM error from a repository is data.

### 11. Lab
Open `services/delivery-service/src/services/deliveries.service.ts`. For each public method, list: (a) which other services it calls, (b) which table it writes, (c) which event it publishes. Draw the result as a table.

### 12. Verification
You can point to the single line where `complete()` frees the driver, the single line where it writes the delivery status, and explain why the driver is freed *before* the order is synced (hint: read the comment block above `assignDriver`).

### 13. Interview questions
- *Beginner:* What is the difference between cohesion and coupling?
- *Intermediate:* Why does the repository layer in Delivery Plus not check roles?
- *Advanced:* Two code paths apply the same state transition. How do you keep them consistent?
- *Senior:* When would you deliberately accept tighter coupling between two services?

### 14. Senior discussion
`delivery-service` synchronously calls `order-service` *and* publishes a Kafka event that `order-service` also consumes. Is that duplication a smell, a safety net, or a migration step? What would you need in place to remove one of the two paths?

---

## Chapter 2 — Abstraction, encapsulation, interfaces and dependency inversion

### 1. Why this exists
You want to test business logic without a real database, Kafka or another service, and you want to swap infrastructure without rewriting business rules.

### 2. Core concept
- **Abstraction**: expose *what* something does, hide *how*.
- **Encapsulation**: keep invariants inside the object/module that owns them; callers cannot put it into an invalid state.
- **Dependency inversion** (the D in SOLID): high-level policy depends on abstractions; low-level details are injected.

NestJS implements dependency inversion with **dependency injection (DI)**: a class declares what it needs in its constructor; the framework supplies it.

### 3. Mental model
"Ask for collaborators, don't build them." A service that says `new Redis(...)` inside itself is welded to Redis. A service that receives `@Inject('REDIS_CLIENT') redis` can be given a fake in tests.

### 4. Delivery Plus mapping — **CURRENT**
- `shared/src/redis/redis.module.ts` provides the `REDIS_CLIENT` token; `shared/src/redis/rate-limiter.service.ts` and `services/cart-service/src/repositories/cart.repository.ts` receive it.
- `shared/src/kafka/kafka-consumer.service.ts` receives `KafkaProducerService` (for dead-lettering) and an *optional* `DurableEventIdempotencyService`. If the service didn't opt in, the consumer still works with a weaker in-process fallback. That is dependency inversion used to make a capability optional.
- Tests build services with fakes: `services/delivery-service/src/services/deliveries.service.spec.ts` constructs `DeliveriesService` with mocked repository, clients and producer.

### 5. Example
```ts
// services/delivery-service/src/services/deliveries.service.ts (abridged)
constructor(
  private readonly deliveries: DeliveriesRepository,
  private readonly orderClient: OrderServiceClient,
  private readonly driverClient: DriverServiceClient,
  private readonly kafkaProducer: KafkaProducerService,
) {}
```
The service never knows the URL of driver-service or how a JWT is minted; `DriverServiceClient` and `SystemTokenService` own that.

### 6. Failure scenario
Encapsulation broken: if any caller could call `deliveries.transition(...)` directly, it could skip `assertAssignedDriver` and mark someone else's delivery DELIVERED. The repository is not exported from the module for that reason; only the service is the entry point.

### 7. Trade-offs
Interfaces for *everything* ("`IOrderRepository` with one implementation forever") add ceremony without value. Abstract at boundaries that really vary: external systems (Kafka, Redis, S3, other services) and things you must fake in tests.

### 8. Performance
DI resolution happens once at startup. No runtime cost after that.

### 9. Security
Abstractions can hide security decisions. `SystemTokenService.mint()` (in `services/delivery-service/src/common/system-token.service.ts`) creates an **ADMIN** JWT for service-to-service calls. Anyone reading `driverClient.getDriver()` must know that call is privileged. Senior habit: name or comment privileged abstractions.

### 10. Operations
Optional dependencies must be visible in production. The Kafka consumer logs a warning at startup when durable idempotency is off — an example of making a degraded mode observable.

### 11. Lab
In `shared/src/kafka/kafka-consumer.service.spec.ts`, find how the test replaces Kafka, the producer and the idempotency service. Write one new test (locally, not committed) that proves an event is skipped when `tryAcquire` returns `processed`.

### 12. Verification
Your test passes with `npx jest src/kafka` inside `shared/`, and fails if you delete the `processed` branch in `handleMessage`.

### 13. Interview questions
- *Beginner:* What does a NestJS provider do?
- *Intermediate:* Why inject `REDIS_CLIENT` instead of creating a Redis client in the service?
- *Advanced:* How would you make a dependency optional without `if (x)` checks everywhere?
- *Senior:* Where should the boundary be between shared library code and service code?

### 14. Senior discussion
`shared/` is used by every service. A change there can break all of them at once. How do you evolve a shared library safely (versioning, contract tests, deprecations)? See issue #30 on GitHub.

---

## Chapter 3 — SOLID, DRY, YAGNI and the danger of over-abstraction

### 1. Why this exists
Principles help, but applied blindly they create the opposite problem: abstractions no one understands.

### 2. Core concept
- **S**ingle responsibility — one reason to change.
- **O**pen/closed — extend behaviour without editing stable code.
- **L**iskov substitution — a subtype must keep the promises of its parent.
- **I**nterface segregation — small, focused interfaces.
- **D**ependency inversion — see Chapter 2.
- **DRY** — every piece of *knowledge* has one authoritative place. (It is about knowledge, not identical-looking lines.)
- **YAGNI** — don't build what you don't need yet.

### 3. Mental model
Duplicate *code* is cheap to fix later; duplicate *knowledge* (two copies of a business rule) silently diverges. Premature abstraction is expensive to undo because callers depend on it.

### 4. Delivery Plus mapping
- **DRY done right — CURRENT:** state machines are defined once in `shared/src/types/enums.ts` (`ORDER_TRANSITIONS`, `DELIVERY_TRANSITIONS`, `PAYMENT_TRANSITIONS`, `DRIVER_TRANSITIONS`) and checked with `isTransitionAllowed`.
- **Acceptable duplication — CURRENT:** each service has its own `system-token.service.ts` (payment, delivery, tracking). Three near-identical copies, but each service owns its identity; extracting it would couple their release cycles.
- **YAGNI — CURRENT:** there is no generic "workflow engine" for order states; a transition table plus compare-and-set is enough for the current scale.
- **Duplicate knowledge that caused a bug — fixed:** the payment-failure status used to be `CANCELLED` in one writer and `FAILED` in another ([case study 01](case-studies/01-failed-payment-race.md)).

### 5. Example
Open/closed in practice: adding a new delivery event type requires adding one enum value in `shared/src/events/delivery-events.ts` and one `publishEvent` call. Consumers that don't care ignore unknown types (the shared consumer commits messages that have no handler).

### 6. Failure scenario
Over-abstraction: a junior wraps every repository call in a generic `BaseRepository<T>` with 20 options. Six months later nobody knows which options are used, and a performance fix requires touching every service.

### 7. Trade-offs
| Choice | Win | Cost |
| --- | --- | --- |
| Extract shared helper | one place to fix | coupling, harder to change for one caller |
| Duplicate small code | independent evolution | fixes must be repeated |
| Abstraction now | flexibility | indirection, guessing future needs |

### 8. Performance — not a primary concern for this chapter.
### 9. Security
Security rules are knowledge: duplicate them and one copy will be wrong. Ownership checks for orders live in order-service and other services *ask* it (`OrderServiceClient.assertReadableBy` in delivery-service) instead of re-implementing them.

### 10. Operations
Fewer abstractions → shorter stack traces → faster incident diagnosis.

### 11. Lab
Search the backend for `system-token.service.ts`. Compare the copies. Decide: extract into `shared/` or not? Write a short paragraph defending your choice.

### 12. Verification
Your paragraph names at least one benefit and one cost, and mentions who would own the shared version.

### 13. Interview questions
- *Beginner:* What does DRY actually mean?
- *Intermediate:* Give an example where duplication is better than abstraction.
- *Advanced:* How do you spot "duplicate knowledge" in a code review?
- *Senior:* When does a shared library become a distributed monolith?

### 14. Senior discussion
Should the order state machine live in `shared/` (as now) or only in order-service? Who else needs it, and what happens when order-service wants a new state?

---

## Chapter 4 — State, side effects, purity, immutability and determinism

### 1. Why this exists
Most production bugs are about *state changing unexpectedly*: twice, out of order, or half-way.

### 2. Core concept
- **Pure function**: same input → same output, no side effects. Easy to test and reason about.
- **Side effect**: anything observable outside the function — DB write, HTTP call, Kafka publish, log, timer.
- **Immutability**: values don't change after creation; you create new ones.
- **Determinism**: the same inputs produce the same result every time, including IDs.

### 3. Mental model
Push decisions into pure code; push effects to the edges. "Decide, then do."

```text
pure:      (currentStatus, requestedStatus, role) → allowed? / which event?
effectful: UPDATE … WHERE status = current;  publish(event)
```

### 4. Delivery Plus mapping
- **Pure — CURRENT:** `isTransitionAllowed(...)` in `shared/src/types/enums.ts`; `isRoleAllowedForTransition(...)` in `services/order-service/src/common/order-transition-rules.ts`.
- **Deterministic IDs — CURRENT:** `lifecycleEventId(entityId, eventType)` in `shared/src/events/event-identity.ts` returns the same UUID v5 for the same delivery + event type; `paymentEventId` in `services/payment-service/src/services/payments.service.ts` does the same for payments. Determinism here is what lets consumers deduplicate a re-published event ([Book 08](08-idempotency-and-distributed-operations.md)).
- **Non-deterministic on purpose — CURRENT:** payment success in the simulator is `Math.random() < paymentSuccessRate` (`services/payment-service/src/services/payments.service.ts`). That is why the E2E environment sets `PAYMENT_SUCCESS_RATE=1` (`docker-compose.e2e.yml`): tests need determinism.

### 5. Example
```ts
// shared/src/events/event-identity.ts
export function lifecycleEventId(entityId: string, eventType: string): string {
  return uuidv5(`${entityId}:${eventType}`, LIFECYCLE_EVENT_NAMESPACE);
}
```
Pure, deterministic, trivially testable.

### 6. Failure scenario
Before this function existed, order events used `uuidv4()` (random). A retried publish produced a *different* eventId, so the consumer's dedup couldn't recognise it as the same event. Determinism was the missing property.

### 7. Trade-offs
Deterministic IDs require that the (entity, type) pair is unique over the entity's life. That holds for one-way lifecycles (orders, deliveries). It would break for something that can legitimately happen twice (e.g. "driver location updated").

### 8. Performance
Pure functions are cache-friendly and parallelisable. UUID v5 costs one SHA-1 hash — negligible.

### 9. Security
Predictable IDs can be a risk when IDs act as secrets. Event IDs are not secrets; resource IDs (orders, deliveries) are random v4 UUIDs and *still* protected by ownership checks — never rely on unguessable IDs alone.

### 10. Operations
Deterministic IDs make logs searchable across retries: grep one eventId and see every attempt.

### 11. Lab
Run `node -e "const {v5}=require('uuid');console.log(v5('order-1:order.confirmed','43b91be0-b664-46b4-99f0-e52f107a8f5c'))"` twice from the repository root. Then change the event type and run again.

### 12. Verification
Same input prints the same UUID; a different event type prints a different one. You can explain why that matters for duplicate delivery.

### 13. Interview questions
- *Beginner:* What is a side effect?
- *Intermediate:* Why is `Math.random()` a problem in tests?
- *Advanced:* When is a deterministic event ID *wrong*?
- *Senior:* How do you design an ID scheme that supports deduplication across services?

### 14. Senior discussion
Should deterministic event IDs be derived from the entity and type, or from the database transaction (for example an outbox row ID)? What changes once a transactional outbox exists ([Book 27](27-advanced-data-patterns.md))?

---

## Chapter 5 — Error handling and defensive programming

### 1. Why this exists
Errors are part of the contract. A caller must be able to tell "you sent something wrong" from "you are not allowed" from "the system is broken right now".

### 2. Core concept
- Distinguish **expected** errors (validation, not found, forbidden, conflict) from **unexpected** ones (bugs, outages).
- Map errors to stable codes at the boundary (HTTP status + machine-readable `error` field).
- Validate input at the edge; assert invariants inside.
- Don't swallow errors; don't leak internals.

### 3. Mental model
```text
Request → DTO validation (400) → auth (401/403) → lookup (404) → rule check (409) → effect (5xx if infra fails)
```
Each step fails *fast* with the most specific error.

### 4. Delivery Plus mapping — **CURRENT**
- Typed errors: `shared/src/errors/app-error.ts` (`BadRequestError` 400, `UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404, `ConflictError` 409, `InvalidStateTransitionError` 409).
- One global filter: `shared/src/nest/filters/http-exception.filter.ts` (`AllExceptionsFilter`) turns any error into `{ statusCode, error, message, timestamp, path, correlationId }` (`shared/src/types/error-response.ts`).
- Input validation: DTOs with `class-validator` (for example `services/tracking-service/src/dto/update-location.dto.ts` uses `@IsLatitude()` / `@IsLongitude()`), plus a global `ValidationPipe` with `forbidNonWhitelisted`.
- Defensive ID checks: `assertValidUuidV4` in `shared/src/utils/id.ts` is called by every service client before building a URL — this blocks path injection into internal HTTP calls.

### 5. Example
`services/notification-service/src/controllers/notifications.controller.ts` uses `new ParseUUIDPipe()` on `:id`. Before that, a malformed ID reached PostgreSQL, which raised a type error, which surfaced as **500**. Now it is a **400**. Same bug, very different signal in monitoring.

### 6. Failure scenario — **PARTIAL** (real weakness)
Look at the last branch of `AllExceptionsFilter`:
```ts
} else if (exception instanceof Error) {
  message = exception.message;
}
```
Any unexpected error's raw message is returned to the client with status 500. A TypeORM or driver error message can contain table names, SQL fragments, or hostnames. That is an information leak. A safer pattern: log the full error with the correlation ID, return a generic message to the client.

### 7. Trade-offs
Detailed errors help developers and attackers alike. Return details for 4xx (the caller can fix them), hide details for 5xx (only operators can), and always include a correlation ID so support can find the log line.

### 8. Performance
Exceptions are slower than return values, but only matters in hot loops. Validating early is a performance win: cheap rejection before expensive I/O.

### 9. Security
- Validation is your first line of defence (injection, oversized payloads).
- `forbidNonWhitelisted` prevents **mass assignment**: a client cannot sneak `role: "ADMIN"` into a DTO.
- Error messages must not reveal existence: notification mark-as-read returns 404 (not 403) for someone else's notification so IDs can't be probed (`markAsRead` in `services/notification-service/src/services/notifications.service.ts`).

### 10. Operations
Every error response carries `correlationId` (set by `shared/src/nest/middleware/correlation-id.middleware.ts`). Production debugging starts from that ID.

### 11. Lab
With the stack running, call `PATCH /api/notifications/not-a-uuid/read` with a valid token and observe the 400. Then call `GET /api/orders/<random-uuid>` and observe the 404 body. Note the `correlationId` and find it in `dc logs order-service`.

### 12. Verification
You found the log line for your request using only the correlation ID from the response.

### 13. Interview questions
- *Beginner:* What is the difference between 401 and 403?
- *Intermediate:* Why return 404 instead of 403 for another user's resource?
- *Advanced:* What should a 500 response body contain?
- *Senior:* How do you design an error contract that is stable across 12 services?

### 14. Senior discussion
Should internal service clients (for example `OrderServiceClient`) convert remote errors into local typed errors, or propagate them? What are the consequences for retries and for the customer-facing message?

---

## Chapter 6 — Reading an unfamiliar codebase and debugging methodically

### 1. Why this exists
Most engineering time is spent in code you didn't write. A method beats intuition.

### 2. Core concept
**Reading**: start from an entry point (route, event, CLI), follow one request end to end, write down every hop.
**Debugging**: reproduce → observe → hypothesise → test one hypothesis → fix → prove with a test.

### 3. Mental model
```text
Symptom  →  Where is it visible?  →  Which hop produced it?  →  What state was it in?  →  Why?
```
Never fix a symptom you can't reproduce.

### 4. Delivery Plus mapping
- Entry points: `services/api-gateway/src/main.ts` (route table), each service's controllers, each service's `onModuleInit` Kafka subscriptions.
- Debug tools — **CURRENT**: correlation IDs, `docker compose logs`, Kafka UI on `localhost:8085`, `psql` into each service database, `redis-cli`, `npm run kafka:dlq`.
- The full navigation guide is [code-reading-guide.md](code-reading-guide.md).

### 5. Example — a real debugging session from this project
Symptom: customers saw "Order Confirmed" twice. Observe: two notification rows, same order, ~40 ms apart. Hypothesis: two `order.confirmed` events. Check Kafka: two events with different random IDs. Why two? Both payment-service's HTTP sync and order-service's `payment.completed` consumer moved the order to CONFIRMED and each published. Fix: compare-and-set in `OrdersRepository.updateStatus` so only the writer that actually changes the row publishes. Proof: a unit test with two concurrent writers. See [case study 06](case-studies/06-in-memory-idempotency.md).

### 6. Failure scenario
"Shotgun debugging": changing three things at once, the bug disappears, nobody knows which change fixed it, and it returns next week.

### 7. Trade-offs
Reading every file is slow; following one request is fast but can miss global behaviour (startup hooks, interceptors). Do both: one vertical slice, then skim module wiring (`*.module.ts`, `app.module.ts`).

### 8. Performance — see [Book 21](21-performance-engineering.md) for performance debugging.
### 9. Security
When debugging, never paste real tokens or customer data into tickets or AI tools. Use the seed accounts.

### 10. Operations
Write down the timeline while debugging; it becomes the incident postmortem ([Book 26](26-reliability-engineering.md)).

### 11. Lab
Using only logs and `psql`, find the full lifecycle of the order created by `npm run e2e`: every status, every event, the delivery and the driver.

### 12. Verification
You produce a timeline table: time, service, action, resulting status — and it matches the order's final `DELIVERED` state.

### 13. Interview questions
- *Beginner:* How do you start reading a new service?
- *Intermediate:* How would you find which service set an order to CANCELLED?
- *Advanced:* A bug happens once a day in production only. How do you approach it?
- *Senior:* How do you make a system easier to debug for the next engineer?

### 14. Senior discussion
What is the minimum observability you would require before allowing a new service into production? ([Book 20](20-observability.md))

---

## Chapter 7 — Technical debt, refactoring and code review

### 1. Why this exists
Every shortcut has interest. Teams that never pay it down slow to a crawl; teams that refactor everything never ship.

### 2. Core concept
- **Technical debt**: a known gap between the code and what it should be, *accepted* for a reason.
- **Refactoring**: changing structure without changing behaviour, protected by tests.
- **Code review**: a second engineer checking correctness, clarity, risk and fit.

### 3. Mental model
Debt is fine when it is **visible** (written down, linked to an issue) and **bounded** (you know what breaks if it bites). Invisible debt is a bug that hasn't happened yet.

### 4. Delivery Plus mapping
- Visible debt — **CURRENT**: `.project-context/13-known-issues-and-gotchas.md` and GitHub milestones list known gaps (no outbox, payment `PROCESSING` recovery, missing timeouts on internal HTTP clients…).
- Debt with a plan — **PLANNED**: transactional outbox (issue #98), checkout re-validation (#42).
- Review gates — **CURRENT**: `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS`, and the PR Quality Gate workflow (`.github/workflows/pr-quality.yml`).

### 5. Example
The driver-service consumer that released drivers on `delivery.completed` was *removed* rather than fixed, because with events actually flowing it would free drivers who were already on a new delivery. Deleting code is often the best refactor. See [case study 09](case-studies/09-driver-availability-lifecycle.md).

### 6. Failure scenario
A "refactor" PR that also changes behaviour hides the behaviour change in a thousand lines of moves. Reviewers approve the moves and miss the change.

### 7. Trade-offs
Small PRs are easier to review but can lose the bigger picture; stacked PRs (as used for the hardening → Kafka-reliability work) keep both.

### 8. Performance — not applicable.
### 9. Security
Security review is part of code review: every new route — who can call it? Every new query — whose data can it return?

### 10. Operations
Review the *rollout* too: migrations, config, feature flags, rollback path ([Book 18](18-cicd-and-devops.md)).

### 11. Lab
Pick any merged PR from the repository history. Write a review of it using the PR template headings. List one risk the PR description does not mention.

### 12. Verification
Your review identifies at least one thing to verify in production after deployment.

### 13. Interview questions
- *Beginner:* What makes a good commit message?
- *Intermediate:* How do you review a PR you don't fully understand?
- *Advanced:* When is it right to merge code with known debt?
- *Senior:* How do you get a team to pay down debt without stopping feature work?

### 14. Senior discussion
`.project-context/` documents the system for humans *and* AI agents. Should architecture documentation live in the repository, in a wiki, or be generated from code? What goes stale fastest?

---

## Chapter 8 — API design basics

### 1. Why this exists
An API is a promise. Clients (the customer app, other services, future driver and restaurant apps) depend on it; breaking it breaks them.

### 2. Core concept
Good APIs are: **resource-oriented**, **predictable** (same patterns everywhere), **explicit** about errors, **safe to retry** where possible, and **versionable**.

### 3. Mental model
Design from the client's job: "what does the driver need on the first screen?" — not from the database tables.

### 4. Delivery Plus mapping — **CURRENT**
- Route table: `services/api-gateway/src/main.ts` maps `/api/<service>` prefixes to services.
- Published contract: `docs/openapi/delivery-plus-public.json`, generated from `services/api-gateway/src/public-openapi.ts` and checked for drift in CI.
- Retry-safe creation: `POST /api/orders` and `POST /api/payments` accept an `Idempotency-Key` header (`services/order-service/src/common/idempotency-key.ts`).
- Lookup designed for a client need: `GET /api/deliveries/by-order/:orderId` exists because the customer app knows the order, not the delivery.
- **PLANNED:** `GET /api/deliveries/me/current` for drivers (issue #96) — designed from the driver app's first screen.

### 5. Example
State changes are modelled two ways in this codebase:
- *Generic*: `PATCH /api/orders/:id/status { "status": "PREPARING" }`.
- *Action endpoints*: `POST /api/deliveries/:id/pickup`, `/start`, `/complete`.
Action endpoints make permissions and side effects explicit per action; the generic form is compact but needs a role table.

### 6. Failure scenario
A client retries `POST /api/orders` after a timeout without an idempotency key → two orders, two charges. That's why the customer app sends one (`delivery-plus-customer-app/src/services/orders.ts`).

### 7. Trade-offs
| Style | Pro | Con |
| --- | --- | --- |
| Generic status PATCH | one endpoint | authorization becomes a table; easy to forget a rule |
| Action endpoints | explicit, self-documenting | more routes |
| GraphQL (**NOT USED**) | client-shaped queries | caching, authorization per field, complexity |

### 8. Performance
Design for the number of round trips. The customer order screen needs the order *and* the delivery: two calls today, polled. A combined endpoint would save a round trip but couple two services' data.

### 9. Security
Every route needs an answer to "who may call this and on whose data?". The public OpenAPI registry marks `auth: true/false` per route; review that file in every PR that adds a route.

### 10. Operations
Contract drift is caught in CI (`npm run openapi:generate` then `git diff --exit-code`).

### 11. Lab
Read `docs/openapi/delivery-plus-public.json` for `/api/deliveries/{id}/complete`. Write down what a driver app needs to know that this contract does not say (hint: retry behaviour).

### 12. Verification
You can explain why calling `complete` twice now returns success instead of 409, and why that matters to a mobile client on a bad network.

### 13. Interview questions
- *Beginner:* PUT vs PATCH vs POST?
- *Intermediate:* How do you make `POST` safe to retry?
- *Advanced:* How do you evolve an API used by mobile apps you can't force-update?
- *Senior:* Action endpoints vs a generic state endpoint — which would you choose for the driver app and why?

### 14. Senior discussion
Should the gateway expose service-shaped routes (`/api/orders`, `/api/deliveries`) or client-shaped routes (`/api/customer/orders/:id/overview`)? What does each mean for team ownership?

---

[Library index](README.md) · Previous: [Book 00](00-how-to-use-this-curriculum.md) · Next: [Book 02 — Data Structures & Algorithms](02-data-structures-and-algorithms.md)
