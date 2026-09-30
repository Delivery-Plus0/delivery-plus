# Testing Strategy

## Current project stance

This repository is set up as a TypeScript monorepo with workspace-level test scripts, but the concrete test strategy is primarily conventional and service-local rather than a heavy, centralized QA harness.

The root scripts are defined in:

- [package.json](../package.json)

The package scripts run:

- `npm run build --workspaces --if-present`
- `npm run lint --workspaces --if-present`
- `npm run test --workspaces --if-present`

## What the repo expects

The project structure has Jest configuration in each service package, which suggests a service-by-service test model:

- each service has a `jest.config.js`
- each service can run its own tests independently
- shared behavior is validated at the package level rather than through one giant integration suite

This is a typical microservice layout for focused unit and integration tests.

## Contract and API automation

The repository now includes a generated public OpenAPI contract at [docs/openapi/delivery-plus-public.json](../docs/openapi/delivery-plus-public.json). It is produced by the root script `npm run openapi:generate` and validated by `npm run openapi:validate`. The intent is to keep the contract aligned with the actual public Gateway route map while preventing private service-only paths and `/docs-json` endpoints from leaking into the public contract.

This contract is designed to be imported into Apidog for workflow automation, while service-level Jest tests remain the code-level verification layer for controllers, guards, and service logic.

## Recommended test layers

### 1. Unit tests

Use unit tests for:

- enum transition validation logic
- guard checks
- service methods
- DTO validation
- pure mapping functions

This is where most branch-level logic belongs.

### 2. Service-layer tests

These verify:

- a request enters the controller or service properly
- repository interactions are correct
- state transitions are allowed or rejected
- command flows behave as expected for order, payment, and delivery movement

### 3. Integration tests

The project’s architecture would benefit from focused integration checks around:

- PostgreSQL-backed domain flows
- Redis cart state handling
- Kafka event publication and consumption
- gateway-to-service routing
- auth token validation paths

These tests should be narrow and explicit because the overall system is distributed.

## State-transition validation is a natural testing target

The shared transition map in:

- [shared/src/types/enums.ts](../shared/src/types/enums.ts)

is an especially good candidate for unit tests because it provides a central definition of allowed lifecycle movement. Tests should confirm:

- valid transitions pass
- invalid transitions fail
- cancellation and terminal states behave as expected

## Docker validation should complement code tests

The stack is designed to run via Docker Compose, and this is a key validation path for local integration confidence:

- [docker-compose.yml](../docker-compose.yml)

A realistic verification flow would include:

- compose build
- compose up
- service health checks
- gateway route verification (the gateway `/health` route is liveness only, so also call a proxied route)
- Kafka + Postgres readiness

This is particularly useful for validating that the project boots correctly in a real multi-container setup.

## Local workflow guidance

When working on this repo, the best practical testing order is:

1. validate the shared state and domain rules
2. run service-specific unit tests
3. validate the relevant service in Docker Compose
4. confirm the gateway and dependencies still expose healthy endpoints

## Important caveat

CI is split across six workflows in `.github/workflows/`, all running on Node 22:

| Workflow | Coverage |
| --- | --- |
| `ci.yml` (CI) | `npm ci`, lint, every workspace's Jest suite with a real Redis service (`REDIS_TEST_URL`), build, Compose config, Trivy scan of the gateway image |
| `pr-quality.yml` (PR Quality Gate) | Lint, unit tests with no infrastructure, build, OpenAPI regeneration must match the committed contract, Compose config for every overlay |
| `security.yml` (Security) | CodeQL, `npm audit` (blocking on critical), Trivy filesystem and secret scan |
| `docker.yml` (Docker Build) | Builds and Trivy-scans every service image |
| `integration.yml` (Integration) | Boots the full Compose test stack, seeds data (`npm run seed`), runs the critical-path workflow (`npm run e2e`) |
| `migration-verification.yml` | Runs every PostgreSQL service's migrations on fresh databases; runs the payment SQL upgrade test against real Postgres |

No workflow collects coverage or enforces a coverage threshold.

### Opt-in real-infrastructure tests

Some specs run against a real backend only when an environment variable is set, and are skipped or fake-backed otherwise, so `npm test` works with no infrastructure:

- `PAYMENT_TEST_DATABASE_URL`: payment-service repository integration test against a disposable Postgres database (run in `migration-verification.yml`).
- `REDIS_TEST_URL`: the shared `DurableEventIdempotencyService` suite also runs its behavior tests against real Redis (run in `ci.yml`), exercising the Lua scripts that the in-memory fake only imitates.

### Jest and ESM-only dependencies

Jest runs each workspace in CommonJS mode through ts-jest. An ESM-only package imported by code under test fails with `SyntaxError: Unexpected token 'export'`. `http-proxy-middleware` 4 is one: `services/api-gateway/src/main.spec.ts` stubs it with `jest.mock` because those tests never exercise the proxy.

Beyond CI, broader local validation still combines:

- workspace-level scripts
- service-level Jest runs
- docker-compose health checks
- manual API checks for gateway and service routes

## Source of truth

- Root scripts: [package.json](../package.json)
- Shared transitions: [shared/src/types/enums.ts](../shared/src/types/enums.ts)
- Compose stack: [docker-compose.yml](../docker-compose.yml)
- Service Jest configs: each service folder under [services](../services)
