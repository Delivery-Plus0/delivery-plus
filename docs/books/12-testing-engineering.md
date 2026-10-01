# Book 12 — Testing Engineering

[Library index](README.md) · Previous: [Book 11](11-nestjs-typescript-backend.md) · Next: [Book 13 — E2E / UI Automation](13-e2e-ui-automation.md)

**Level:** Junior → Advanced · **Prerequisites:** [Book 11](11-nestjs-typescript-backend.md).

Delivery Plus has unit tests in every workspace (42 `*.spec.ts` files), database integration tests, contract checks, a full-stack critical-path test in CI, an isolated E2E environment and Maestro UI suites for the customer app. This book explains what each level proves, what it cannot prove, and why five real bugs were only found by UI tests.

---

## Chapter 1 — The test pyramid and what each level proves

### 1. Why this exists
Tests are evidence. Each level answers a different question at a different cost.

### 2. Core concept
```text
            ▲  few, slow, high confidence in the *business flow*
           /█\   UI / E2E (Maestro)
          /███\  business-flow tests (order → kitchen → driver → delivered)
         /█████\ API / contract tests (OpenAPI drift, npm run e2e)
        /███████\ integration (real PostgreSQL, real Redis)
       /█████████\ unit (fakes, milliseconds)
            ▼  many, fast, high confidence in *one rule*
```
- **Unit**: one class, collaborators faked.
- **Integration**: real infrastructure (DB, Redis, Kafka) for one component.
- **API / contract**: HTTP behaviour and published shapes.
- **E2E**: the whole system through its public entry points.
- **UI**: the real client, as a user drives it.

### 3. Mental model
Each level is cheap where the level below is blind. Unit tests can't see wiring; API tests can't see the screen.

### 4. Delivery Plus mapping — **CURRENT**
| Level | Where | Runs in |
| --- | --- | --- |
| Unit | `services/*/src/**/*.spec.ts`, `shared/src/**/*.spec.ts` (Jest) | `ci.yml`, `pr-quality.yml` |
| Integration — Redis | `shared/src/kafka/durable-event-idempotency.service.spec.ts` against real Redis when `REDIS_TEST_URL` is set | `ci.yml` (Redis service container) |
| Integration — PostgreSQL | `services/payment-service/src/repositories/payments.repository.integration.spec.ts` (`PAYMENT_TEST_DATABASE_URL`, otherwise `describe.skip` — the "15 skipped" in local runs) | `migration-verification.yml` |
| Migrations | all migrations on fresh DBs; legacy payment schema upgrade | `migration-verification.yml` |
| Contract | `npm run openapi:generate` + `git diff --exit-code` + `openapi:validate` | `pr-quality.yml` |
| API E2E (critical path) | `scripts/e2e.ts` after `scripts/seed.ts` on the Compose test stack | `integration.yml` |
| UI E2E | Maestro flows in `delivery-plus-customer-app/e2e/flows/` against `docker-compose.e2e.yml` | `delivery-plus-customer-app/.github/workflows/e2e.yml` (not yet running on GitHub) |
| Kafka integration | **NOT IMPLEMENTED** (kafkajs is mocked in unit tests; Kafka is exercised only end-to-end) | — |
| Load / performance | **NOT IMPLEMENTED** | — |

### 5. Example — the same rule at three levels: "a customer can't read another customer's order".
- Unit: `orders.service.spec.ts` expects `ForbiddenError`.
- API: a `curl` with another customer's token gets 403.
- UI: `regression/unauthorized-order.yaml` opens the other customer's order link and expects the error state.

### 6. Failure scenario — "all green" but broken: in this project the order detail screen crashed on web (React Compiler evaluated `order!.id` while loading) and the delivery card spun forever. Every backend and unit test passed; only the Maestro UI suite caught them ([case study 15](case-studies/15-e2e-environment.md)).

### 7. Trade-offs — more high-level tests = more confidence and more flakiness/time. Push each rule to the lowest level that can prove it; keep a few high-level tests for the flows that make money.
### 8. Performance — unit suites: seconds; integration workflow: ~10 min; full Maestro run: ~8 min locally.
### 9. Security — authorization deserves tests at every level (negative tests especially).
### 10. Operations — tests are deploy gates; flaky gates train people to ignore failures.

### 11. Lab
Run `npm test` at the root and note which workspaces skip tests and why (`PAYMENT_TEST_DATABASE_URL`).

### 12. Verification
You can explain the 15 skipped tests and how to run them locally against the dev PostgreSQL.

### 13. Interview questions
- *Beginner:* Unit vs integration test?
- *Intermediate:* What can't a unit test with mocks prove?
- *Advanced:* Why can API tests alone not prove the business workflow works?
- *Senior:* Design the test strategy for the driver app before it exists.

### 14. Senior discussion
There is no Kafka integration test level. Would you add Testcontainers-based Kafka tests for the shared consumer, or rely on the E2E stack? What would each catch?

---

## Chapter 2 — Unit tests, mocks, fakes and stubs

### 1. Why this exists
Fast feedback on business rules, especially failure paths that are hard to produce for real (driver-service down at exactly the right moment).

### 2. Core concept
- **Stub**: returns canned answers.
- **Mock**: records calls so you can assert on them.
- **Fake**: a working lightweight implementation (in-memory Redis with real semantics).
- **Spy**: wraps a real object and records calls.

### 3. Mental model
Fake what you own and understand; be very careful mocking what you don't (a mocked library that behaves differently from the real one).

### 4. Delivery Plus mapping — **CURRENT**
- **Fake**: `FakeRedis` in `shared/src/kafka/durable-event-idempotency.service.spec.ts` reproduces the Lua scripts' semantics with a manual clock — then the *same tests* run against real Redis in CI. That is the gold standard: fake for speed, real for honesty.
- **Mocks**: `jest.fn()` repositories, clients and producers in service specs; `jest.mock('kafkajs')` in `shared/src/kafka/kafka-consumer.service.spec.ts`.
- **Invocation order assertions**: the delivery tests assert the driver is released *before* the order sync (`invocationCallOrder`).

### 5. Example
```ts
// deliveries.service.spec.ts — failure path that is hard to reproduce for real
driverClient.releaseDriver.mockRejectedValueOnce(new Error('driver-service unavailable'));
await expect(completeAsDriver()).rejects.toThrow('driver-service unavailable');
deliveries.findById.mockResolvedValueOnce(at(DeliveryStatus.DELIVERED));
await completeAsDriver(); // retry succeeds and releases the driver
```

### 6. Failure scenario — a mock that returns `affected: 1` for every CAS update hides the concurrency bug CAS exists to catch. Concurrency is better tested with two real sessions (labs DB-05, DS-05).
### 7. Trade-offs — over-mocked tests break on every refactor ("tests that test the implementation").
### 8. Performance — thousands of unit tests per minute.
### 9. Security — write the "refused" cases first.
### 10. Operations — keep unit tests deterministic: no real time (`Date.now()` mocked or injected), no random IDs where assertions depend on them.

### 11. Lab
Write a failing test for the cart lost-update race (it will be hard with mocks — note why) and then reproduce it for real in [RD-02](labs/redis-labs.md#rd-02-lost-update-in-the-cart).

### 12. Verification
You can explain why the race is invisible to a mocked repository test.

### 13. Interview questions
- *Beginner:* Mock vs stub?
- *Intermediate:* What is a fake and when is it better?
- *Advanced:* How do you test time-dependent code (leases, TTLs)?
- *Senior:* How do you keep mocks consistent with real behaviour?

### 14. Senior discussion
The idempotency service is tested against a fake *and* real Redis. Which other components deserve that dual approach?

---

## Chapter 3 — Integration, contract and migration tests

### 1. Why this exists
Many bugs live at boundaries: SQL that compiles but violates a constraint, a migration that fails on a real schema, an API change that breaks the published contract.

### 2. Core concept
- **Database integration test**: run repository code against a real database.
- **Contract test**: verify the provider still satisfies what consumers expect (OpenAPI drift, Pact-style consumer contracts).
- **Migration test**: apply all migrations to a fresh DB and to an old schema.

### 3. Mental model
Integration tests answer "does my code agree with the real thing?"

### 4. Delivery Plus mapping — **CURRENT**
- `payments.repository.integration.spec.ts`: unique active payment per order, idempotency keys — against real PostgreSQL in `migration-verification.yml`.
- Migration verification: every service's migrations on fresh databases + "no pending" check + legacy payment upgrade test.
- Contract: public OpenAPI is generated from code and committed; CI fails if they differ.
- **NOT IMPLEMENTED:** consumer-driven contract tests between services (e.g. delivery-service's expectations of order-service's `GET /orders/:id`), event-contract tests (issue #23).

### 5. Example — the OpenAPI drift check caught nothing in the hardening work *because* the regenerated file was committed — that is the point: the PR diff shows the contract change to reviewers.
### 6. Failure scenario — a renamed field in `PaymentPayload` breaks order confirmation without failing any test (Book 07 Ch. 9). An event-contract test (producer emits a fixture; consumer parses it) would catch it.
### 7. Trade-offs — integration tests need infrastructure in CI (service containers); slower and occasionally flaky.
### 8. Performance — minutes per workflow.
### 9. Security — CI databases must use throwaway credentials (they do: `postgres/postgres` in CI only).
### 10. Operations — migration tests are the cheapest insurance against a failed production deploy.

### 11. Lab
Run the payment integration tests locally:
```bash
dc exec postgres psql -U postgres -c "CREATE DATABASE payment_it;"
PAYMENT_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/payment_it npm test --workspace=services/payment-service
```
(The dev overlay does not publish PostgreSQL's port; run this against the test overlay — `docker compose -f docker-compose.base.yml -f docker-compose.test.yml up -d postgres` publishes `5432` — or from inside the network.)

### 12. Verification
The previously skipped "PostgreSQL integration" suite runs and passes.

### 13. Interview questions
- *Beginner:* What is a contract test?
- *Intermediate:* Why test migrations?
- *Advanced:* Consumer-driven contracts vs provider schema checks?
- *Senior:* What contract tests would you add first in Delivery Plus?

### 14. Senior discussion
Is a generated, committed OpenAPI file a contract test, a documentation artifact, or both?

---

## Chapter 4 — Deterministic data, fixtures, isolation and flakiness

### 1. Why this exists
A test that sometimes fails is worse than no test: people learn to ignore red.

### 2. Core concept
- **Deterministic data**: the same seed produces the same accounts, prices, and scenarios.
- **Isolation**: tests don't share mutable state (or reset it).
- **Flakiness sources**: time, randomness, ordering, shared state, network, async waits, rate limits.

### 3. Mental model
Every nondeterministic input must be pinned, injected or waited for explicitly.

### 4. Delivery Plus mapping — **CURRENT**
- `npm run seed:e2e` (`scripts/seed-e2e.ts`): fixed accounts (`qa.customer`, `qa.customer2`, `qa.restaurant`, `qa.driver` @ `delivery-plus.test`), fixed catalogue (QA Kitchen with fixed prices, one sold-out item; QA Night Cafe closed), four order scenarios (delivered, payment declined, waiting for a driver, another customer's order), and a git-ignored manifest of generated IDs.
- Randomness pinned: `PAYMENT_SUCCESS_RATE=1` in `docker-compose.e2e.yml` (otherwise 10% of checkouts fail randomly).
- Shared state reset: the E2E runner clears `ratelimit:*` keys in the E2E Redis between flows (`delivery-plus-customer-app/e2e/scripts/run.mjs`); the integration workflow `FLUSHDB`s Redis between seed and E2E.
- Isolation: a separate Compose project (`delivery-plus-e2e`) with its own volumes and ports.

### 5. Example — the "random decline" flake: with the default 0.9 success rate, roughly 1 in 10 UI checkout runs would fail for no code reason. Pinning it to 1 and covering declines with a *seeded* failed-payment scenario (S2) keeps both deterministic.
### 6. Failure scenario — rate limits as a flake source: the login rate limit (5/min) fails the 6th login in a test run; seed then E2E in quick succession hit 429 — solved by resetting counters in test environments only.
### 7. Trade-offs — resetting state between tests costs time; sharing state is fast and flaky.
### 8. Performance — reuse the environment, reset only what tests touch.
### 9. Security — test-only passwords (`E2E_PASSWORD`) and localhost-only guards (`seed-e2e` refuses non-localhost targets unless explicitly allowed) keep test tooling from touching real systems.
### 10. Operations — the E2E environment is the closest thing to a staging environment today.

### 11. Lab
[E2E-01 Reset and inspect the E2E environment](labs/e2e-labs.md#e2e-01-reset-and-inspect-the-e2e-environment).

### 12. Verification
Two consecutive `npm run e2e:env:reset` runs produce the same accounts and scenarios (different UUIDs, same structure in the manifest).

### 13. Interview questions
- *Beginner:* What makes a test flaky?
- *Intermediate:* Why seed through the public API instead of SQL inserts?
- *Advanced:* How do you test a random outcome deterministically?
- *Senior:* Design test data management for four apps sharing one backend.

### 14. Senior discussion
`seed-e2e` creates data through the gateway (slower, exercises real rules). When would you seed directly in the database instead?

---

## Chapter 5 — API vs business-flow vs UI tests

### 1. Why this exists
"The API works" is not "a customer can order food".

### 2. Core concept
- **API test**: request → response correct.
- **Business-flow test**: a sequence across services and roles reaches the intended business outcome.
- **UI test**: a real user path through the real client, including rendering, navigation, caching and error states.

### 3. Mental model
API tests check the parts; flow tests check the plumbing; UI tests check what the customer actually experiences.

### 4. Delivery Plus mapping — **CURRENT**
- API critical path: `scripts/e2e.ts` (customer → order → payment → restaurant → delivery → driver → `DELIVERED`).
- Business flow in the UI: `e2e/flows/business/customer-order-lifecycle.yaml` — the customer orders through the UI; restaurant and driver steps are **API stand-ins** triggered through the runner's control server (no restaurant or driver apps exist yet); the customer UI then shows each stage and the notification.
- Regression UI flows: awaiting driver, declined payment, unauthorized order, offline recovery.

### 5. Example — why API tests missed the UI bugs: the API returned a correct `null` for "no delivery yet"; the client's cache treated `null` as "not loaded" and kept showing a skeleton forever.
### 6. Failure scenario — stand-ins hide integration gaps: the business flow passes even though no driver can *discover* their delivery (issue #96) — the stand-in reads the delivery ID from the seed manifest.
### 7. Trade-offs — full UI flows are slow (~1.5 min each); keep them few and meaningful.
### 8. Performance — run smoke UI flows on PRs and full suites nightly (the customer app's `e2e.yml` does this split).
### 9. Security — the unauthorized-order flow is a security regression test at the UI level.
### 10. Operations — UI failures produce screenshots and debug output as CI artifacts.

### 11. Lab
[E2E-04 Full business-flow validation](labs/e2e-labs.md#e2e-04-full-business-flow-validation).

### 12. Verification
You can point to each stand-in step in the flow and name the future client (driver app #99, restaurant dashboard #100) that will replace it.

### 13. Interview questions
- *Beginner:* E2E vs integration test?
- *Intermediate:* Why did API tests not catch the stuck delivery card?
- *Advanced:* What are the risks of API stand-ins in a business-flow test?
- *Senior:* When the driver app exists, how do you run a cross-app flow in CI?

### 14. Senior discussion
Is a business-flow test with stand-ins still valuable? What exactly does it prove today, and what does it not?

---

## Chapter 6 — Performance, load, stress, soak and chaos testing

### 1. Why this exists
Correct at 1 request per second says nothing about 500.

### 2. Core concept
- **Load test**: expected traffic — does it meet latency targets?
- **Stress test**: beyond expected — where does it break, and how?
- **Soak test**: long duration — leaks, growth, slow degradation.
- **Spike test**: sudden bursts.
- **Chaos test**: inject failures (kill a service, add latency) and verify graceful behaviour.

### 3. Mental model
Performance tests answer "how much?" and "how does it fail?", not "does it work?".

### 4. Delivery Plus mapping
- **NOT IMPLEMENTED:** no load-testing tool or scripts in the repository.
- **CURRENT (manual chaos):** the offline-recovery UI flow stops and restarts the gateway; the retry-safety work was verified by stopping order-service and driver-service mid-flow.
- Labs in this library supply the first experiments ([Book 21](21-performance-engineering.md)).

### 5. Example — a k6 script (FUTURE, illustrative):
```js
import http from 'k6/http';
export const options = { vus: 50, duration: '2m' };
export default function () {
  http.get('http://localhost:3000/api/restaurants?page=1&limit=20');
}
```
### 6. Failure scenario — load-testing checkout hits the 5-per-minute order rate limit immediately; you must test with many users or adjust limits in the test environment.
### 7. Trade-offs — production-like load tests need production-like data and infrastructure; local results only show relative behaviour.
### 8. Performance — the whole point; see Book 21.
### 9. Security — never load-test third-party endpoints (payment providers) without permission.
### 10. Operations — chaos experiments need a hypothesis, a blast radius and an abort plan.

### 11. Lab
[OPS-05 Load test the restaurant list](labs/devops-labs.md#ops-05-load-test-the-restaurant-list).

### 12. Verification
You report p50/p95/p99 and the throughput at which errors start.

### 13. Interview questions
- *Beginner:* Load vs stress test?
- *Intermediate:* What does a soak test find?
- *Advanced:* How do you load-test an endpoint protected by per-user rate limits?
- *Senior:* Design a chaos experiment for Kafka unavailability during checkout.

### 14. Senior discussion
Which single load test would give Delivery Plus the most useful information today, and what would you change based on its result?

---

[Library index](README.md) · Previous: [Book 11](11-nestjs-typescript-backend.md) · Next: [Book 13 — E2E / UI Automation](13-e2e-ui-automation.md)
