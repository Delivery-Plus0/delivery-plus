# Case Study 15 — E2E Environment

**Status: CURRENT (commit `1845791`; Maestro suites in the customer app)** · [Case studies](README.md) · Books: [13](../13-e2e-ui-automation.md), [14](../14-docker-and-containers.md) · Labs: [E2E-01](../labs/e2e-labs.md#e2e-01-reset-and-inspect-the-e2e-environment) – [E2E-04](../labs/e2e-labs.md#e2e-04-full-business-flow-validation)

## Symptom (before)

UI tests ran against the **dev** stack, and they were flaky in ways that had nothing to do with the app:
- Dev data changed between runs: manual testing, `seed:demo`, leftover carts.
- About 10% of checkouts failed, because `PAYMENT_SUCCESS_RATE` defaults to 0.9.
- Rate limits from earlier runs caused 429s on sign-in.
- Running tests and developing at the same time fought over the same ports and data.

## Root cause

There was no isolation between "the environment a developer uses" and "the environment a test asserts on". Tests depended on state that nobody controlled.

## Why the naive version looked reasonable

- One stack is simpler.
- The demo seed already had nice data.
- Random payment failures are realistic, which is good for manual testing.

## Fix

- **A separate Compose project** (`docker-compose.e2e.yml`, project `delivery-plus-e2e`) layered on base + test. It has its own containers, network and volumes:
  - gateway on `127.0.0.1:3100`, object storage on `:9100`, no other host ports;
  - it runs next to the dev stack on `:3000`.
- **Deterministic behaviour:** `PAYMENT_SUCCESS_RATE=1`. Failure scenarios are *seeded*, not random.
- **`npm run seed:e2e`** (`scripts/seed-e2e.ts`):
  - creates `qa.*@delivery-plus.test` accounts with a test-only password;
  - creates *QA Kitchen* and *QA Night Cafe* with fixed prices;
  - creates four order scenarios: delivered, failed, awaiting driver, and another customer's order;
  - **refuses non-localhost targets**;
  - writes generated IDs to `e2e-seed-manifest.json` (git-ignored).
- **`npm run e2e:env:reset`** = down `-v` → up `--build --wait` → seed. Every run starts from the same structure.
- **The customer-app runner** (`delivery-plus-customer-app/e2e/scripts/run.mjs`):
  - builds the web app with the E2E API URL (`--clear` so a stale Metro cache can't keep the old URL);
  - clears rate-limit counters between flows;
  - runs a **control server** for stand-in actors (restaurant, driver) and fault injection (`gateway/stop`/`start`);
  - always restarts the gateway if a fault-injection flow fails half-way.

## Tests

- Suites: `smoke` (login, browse, cart, checkout), `regression` (offline recovery, awaiting driver, payment failed, unauthorized order), `business` (full lifecycle).

## Trade-offs

- A second full stack uses RAM and CPU. Running both stacks needs a capable machine.
- `PAYMENT_SUCCESS_RATE=1` means the random-failure path is only tested through the seeded FAILED order and unit tests.
- Stand-ins exercise the **API contracts** of the restaurant and driver sides, but not their UIs, which don't exist yet ([E2E-05](../labs/e2e-labs.md#e2e-05-design-the-driver-app-smoke-suite)).

## What can still go wrong

- Clearing rate limits inside the runner hides real rate-limit regressions. That's a deliberate choice: those belong in API tests.
- Seeded IDs change per reset. Flows must look things up by **name or test ID**, never by a hard-coded UUID.
- React Native Web cannot scroll in Maestro in some layouts, so flows use `scrollUntilVisible` only where it works.

## What a senior engineer would ask

1. What is the *contract* between the seed and the flows? Is the manifest the only coupling?
2. How long does a reset take, and is it fast enough to run per pull request?
3. Which assertions are about the app and which about the backend? Could a backend bug pass the smoke suite?
4. How would you run this in CI on every PR to both repositories?
