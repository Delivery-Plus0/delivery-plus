# Book 13 — E2E / UI Automation

[Library index](README.md) · Previous: [Book 12](12-testing-engineering.md) · Next: [Book 14 — Docker & Containers](14-docker-and-containers.md)

**Level:** Intermediate · **Prerequisites:** [Book 12](12-testing-engineering.md).

This book is built around the real customer-app UI automation: Maestro flows that drive the Expo web build against an isolated, seeded Delivery Plus backend. Files live in the customer-app repository (`delivery-plus-customer-app/e2e/`) and in the backend (`docker-compose.e2e.yml`, `scripts/seed-e2e.ts`, `docs/e2e.md`).

```text
Test data (seed:e2e)  →  E2E env (Compose project delivery-plus-e2e, gateway :3100)
   →  App build (expo export --platform web, API URL baked in)  →  static server :8083
   →  Maestro (headless Chromium)  →  real UI actions + assertions
   →  control server :8090 (API stand-ins for restaurant/driver, fault injection)
```

**Labs:** [e2e-labs.md](labs/e2e-labs.md).

---

## Chapter 1 — What E2E means and what it costs

### 1. Why this exists
Only an end-to-end run proves that a customer can actually complete the business flow on the real client.

### 2. Core concept
- **E2E**: drive the system through its real entry point (the app UI) against a real backend.
- **Black-box**: the test knows only what a user sees (labels, test IDs), not internals.
- Costs: slower, environment-dependent, more failure sources (flakiness).

### 3. Mental model
E2E tests are expensive smoke detectors: few, placed on the paths that make or lose money.

### 4. Delivery Plus mapping — **CURRENT**
Suites in `delivery-plus-customer-app/e2e/flows/`:
| Suite | Flows | When |
| --- | --- | --- |
| `smoke/` | `01-login`, `02-browse`, `03-cart`, `04-checkout` | every PR |
| `regression/` | `order-awaiting-driver`, `order-payment-failed`, `unauthorized-order`, `offline-recovery` | nightly |
| `business/` | `customer-order-lifecycle` (order → kitchen → dispatch → driver → delivered → notification) | nightly |
Shared steps: `_shared/login.yaml`, `_shared/open-qa-kitchen.yaml`.

### 5. Example — `smoke/04-checkout.yaml` adds two items, checks the subtotal is `$7.00`, places the order through the real gateway, and asserts the order screen shows `Confirmed`.
### 6. Failure scenario — testing everything end-to-end: a 2-hour suite nobody waits for, failing intermittently; teams stop trusting it.
### 7. Trade-offs — E2E proves integration and rendering; it's poor at isolating *why* something failed.
### 8. Performance — the full 9-flow run takes ~8 minutes locally; login dominates each flow.
### 9. Security — the `unauthorized-order` flow guards a real authorization rule at the UI level.
### 10. Operations — results are JUnit reports plus per-flow screenshots and debug logs (`e2e/.artifacts`).

### 11. Lab
[E2E-02 Customer login and checkout](labs/e2e-labs.md#e2e-02-customer-login-and-checkout).

### 12. Verification
The smoke suite passes locally; you can find the screenshot of the final step.

### 13. Interview questions
- *Beginner:* What is an E2E test?
- *Intermediate:* Why only a few E2E tests?
- *Advanced:* How do you diagnose a failed E2E run in CI?
- *Senior:* Which flows deserve E2E coverage for the driver app?

### 14. Senior discussion
Should E2E tests run against the web build (fast, CI-friendly) or native builds (closer to users)? What does Delivery Plus lose by testing web only today?

---

## Chapter 2 — Deterministic environments and test data

### 1. Why this exists
E2E tests must start from a known world every time.

### 2. Core concept
- Isolated environment (own databases, ports).
- Seeded through public APIs (data passes the same validation as real traffic).
- Known accounts, fixed prices, pre-built scenarios, a manifest of generated IDs.

### 3. Mental model
`npm run e2e:env:reset` = "factory reset the world".

### 4. Delivery Plus mapping — **CURRENT**
- `docker-compose.e2e.yml` (backend repo): separate Compose project `delivery-plus-e2e`, gateway `127.0.0.1:3100`, object storage `:9100`, no other host ports, `PAYMENT_SUCCESS_RATE=1`.
- `npm run e2e:env:up | down | reset` (`package.json`).
- `npm run seed:e2e` (`scripts/seed-e2e.ts`): QA accounts, QA Kitchen / QA Night Cafe, scenarios S1–S4, manifest `e2e-seed-manifest.json` (git-ignored). Refuses non-localhost targets unless `E2E_ALLOW_REMOTE=1`.
- Shared helpers with the demo seed: `scripts/lib/gateway-seed.ts`.
- Design notes: `docs/e2e.md`, [case study 15](case-studies/15-e2e-environment.md).

### 5. Example — the runner reads order IDs from the manifest to open "a waiting order" directly (`order-awaiting-driver.yaml` uses `openLink` with the S3 order ID).
### 6. Failure scenario — tests that depend on data created by previous tests: run one flow alone and it fails. Each Delivery Plus flow starts with `launchApp: clearState: true` and logs in.
### 7. Trade-offs — a full reset takes minutes (images, migrations, seed); a per-flow reset would be slower still. The current approach resets once per run and resets rate limits per flow.
### 8. Performance — reuse built images; seed through the gateway in parallel where possible.
### 9. Security — test passwords are test-only (`E2E_PASSWORD` override), and the manifest is ignored by git.
### 10. Operations — the E2E stack runs *next to* the dev stack (different project and ports).

### 11. Lab
[E2E-01 Reset and inspect the E2E environment](labs/e2e-labs.md#e2e-01-reset-and-inspect-the-e2e-environment).

### 12. Verification
Both stacks run simultaneously; `curl localhost:3000/health` and `curl localhost:3100/health` both answer.

### 13. Interview questions
- *Beginner:* Why seed test data?
- *Intermediate:* Why through the API instead of SQL?
- *Advanced:* How do you pin randomness (payments) without losing coverage?
- *Senior:* Design test data for parallel E2E runs in CI.

### 14. Senior discussion
Should the E2E environment become the staging environment, or stay disposable?

---

## Chapter 3 — Selectors, accessibility and the Maestro web specifics

### 1. Why this exists
Tests break when they depend on layout or wording. Stable selectors decouple tests from cosmetics.

### 2. Core concept
- **Test IDs**: explicit, stable identifiers on interactive elements.
- **Accessibility selectors**: labels/roles that also serve screen readers — a good test is often a good accessibility check.
- **Text selectors**: brittle, but sometimes exactly what you want to assert (a price).

### 3. Mental model
Select by **intent** (`checkout-place-order`), assert by **content** (`Place order · $7.00`).

### 4. Delivery Plus mapping — **CURRENT** (all learned the hard way, recorded in `delivery-plus-customer-app/e2e/README.md`)
- Components set both `testID` and `nativeID` with the same value: on React Native Web, `nativeID` becomes the HTML `id`, which Maestro's web driver matches first; `testID` becomes `data-testid`. Native platforms use `testID`.
- IDs follow a convention: `add-<item name>`, `qty-<item>-value`, `restaurant-<name>`, `order-status`, `delivery-stage`, `tab-orders`.
- Maestro text selectors are **full-match regular expressions**: `"1× QA Fries"` must be matched with `'.*QA Fries'`, and `$`/`.` must be escaped (`'\$7\.00'`).
- Maestro's web driver can't scroll React Native Web `ScrollView`s (it scrolls the window, while RN-Web keeps `body` from scrolling), so runs use a tall viewport (`--screen-size 430x1600`) and keep `scrollUntilVisible` steps for native.

### 5. Example
```yaml
- extendedWaitUntil:
    visible:
      id: cart-subtotal
      text: '\$7\.00'
    timeout: 15000
```

### 6. Failure scenario — an ID that includes dynamic data (`order-card-<uuid>`) is fine for assertions but useless for "tap the first order"; combine with stable container IDs.
### 7. Trade-offs — test IDs are invisible noise in production markup; accessibility labels serve users too but change with copy.
### 8. Performance — explicit waits (`extendedWaitUntil` with a timeout) beat fixed sleeps.
### 9. Security — none.
### 10. Operations — selector conventions must be documented and reviewed, or each developer invents their own.

### 11. Lab
Add a test ID to one element in a branch of the customer app and assert it in a new flow (see "Adding a flow" in `delivery-plus-customer-app/e2e/README.md`).

### 12. Verification
Your flow passes on web and the element has both `id` and `data-testid` attributes in the browser DOM.

### 13. Interview questions
- *Beginner:* Why use test IDs instead of text?
- *Intermediate:* How do test IDs relate to accessibility?
- *Advanced:* Why did Delivery Plus need `nativeID` as well as `testID`?
- *Senior:* What selector conventions would you mandate for three apps?

### 14. Senior discussion
Should every interactive element get a test ID by default (lint rule), or only those used by tests?

---

## Chapter 4 — Authentication, stand-ins, fault injection and isolation

### 1. Why this exists
Real flows involve other actors (restaurant, driver) and failures (network loss) that a single-app UI test can't produce by itself.

### 2. Core concept
- Log in through the UI in a shared sub-flow (tests the real login).
- Use **stand-ins** for actors without a client.
- Use a **control plane** to inject faults.
- Reset shared state (rate limits) between flows.

### 3. Mental model
The test runner is a puppeteer with two hands: one drives the UI, the other drives the world around it.

### 4. Delivery Plus mapping — **CURRENT**
- Control server in `delivery-plus-customer-app/e2e/scripts/run.mjs` (port `8090`) exposes actions: `restaurant/prepare`, `restaurant/ready`, `restaurant/dispatch`, `driver/pickup`, `driver/start`, `driver/complete`, `gateway/stop`, `gateway/start`.
- Flows call it through `runScript` → `e2e/scripts/control.js` (`http.post` to the control URL) and read results from `output.control`.
- `offline-recovery.yaml` stops the gateway container, asserts the offline state, restarts it, and checks the session survived.
- Rate limits are cleared in the E2E Redis between flows (`ratelimit:*` keys).
- The runner spawns Maestro **asynchronously** — a synchronous spawn deadlocked because flows call back into the runner's own control server.

### 5. Example — the business flow (`business/customer-order-lifecycle.yaml`): UI checkout → `restaurant/prepare` → `restaurant/ready` → UI shows "Finding a driver" → `restaurant/dispatch` → UI "Driver assigned" → `driver/pickup` → … → UI "Delivered" → Alerts tab shows "…has been confirmed".
### 6. Failure scenario — a stand-in that bypasses a real constraint (reading the delivery ID from the manifest) can hide that the real driver app couldn't do the same (#96).
### 7. Trade-offs — stand-ins make flows possible today; they must be replaced as clients arrive (driver app #99, restaurant dashboard #100).
### 8. Performance — API stand-ins are fast compared with driving a second UI.
### 9. Security — the control server can stop containers; it must never be exposed outside the CI runner/localhost.
### 10. Operations — fault-injection flows double as resilience regression tests.

### 11. Lab
[E2E-03 Failure screenshot and offline recovery](labs/e2e-labs.md#e2e-03-failure-screenshot-and-offline-recovery).

### 12. Verification
You break one assertion on purpose, find the failure screenshot, then restore and watch the offline flow recover.

### 13. Interview questions
- *Beginner:* Why log in through the UI in E2E?
- *Intermediate:* What is a test stand-in?
- *Advanced:* How do you inject network failure in a UI test?
- *Senior:* How do you replace stand-ins without losing coverage during the transition?

### 14. Senior discussion
Should cross-app business flows (customer + driver + restaurant UIs) run as one orchestrated test, or as three app suites plus API stand-ins? What does each prove?

---

## Chapter 5 — CI execution, parallelism, retries and artifacts

### 1. Why this exists
Tests that only run on one laptop protect nothing.

### 2. Core concept
- Run smoke on PRs, full suites nightly.
- Parallelise by flow (needs isolated data per worker).
- Retries: allowed for infrastructure flakiness, never to hide app bugs; report retried passes.
- Artifacts: JUnit, screenshots, videos, backend logs.

### 3. Mental model
A CI E2E job is a small production environment that lives for 15 minutes.

### 4. Delivery Plus mapping
- **CURRENT (written, not yet running):** `delivery-plus-customer-app/.github/workflows/e2e.yml` — PR → smoke; nightly cron + manual → all suites. It checks out the backend (`BACKEND_REPOSITORY`, `BACKEND_REF`, default `dev`), starts the E2E stack, seeds, installs Maestro and Java 17, builds the web app, runs headless, uploads `e2e/.artifacts` and backend logs on failure.
- **Blocker:** the customer-app repository has no GitHub remote yet, so the workflow has never run on GitHub.
- **NOT IMPLEMENTED:** parallel flow execution, automatic retries.

### 5. Example — the runner flags: `node e2e/scripts/run.mjs --suite smoke --build --headless`.
### 6. Failure scenario — "works locally, fails in CI": the API URL is baked into the web build at `expo export` time; a warm Metro cache kept an old `EXPO_PUBLIC_API_BASE_URL` until the runner added `--clear`.
### 7. Trade-offs — PR smoke (fast, partial) vs full suites on every PR (slow, complete).
### 8. Performance — Docker layer caching and reusing built images dominate CI time.
### 9. Security — CI uses test-only secrets; never production credentials.
### 10. Operations — track flake rate per flow; quarantine flaky flows with an owner and a deadline.

### 11. Lab
Read `delivery-plus-customer-app/.github/workflows/e2e.yml` and list every external dependency it needs (repos, tools, ports). Mark which would break first.

### 12. Verification
Your list includes the backend checkout, Docker, Java, Maestro, Node and the `BACKEND_REF` default.

### 13. Interview questions
- *Beginner:* Why run E2E in CI?
- *Intermediate:* Why only smoke on PRs?
- *Advanced:* How do you make E2E runs parallel-safe?
- *Senior:* Policy for flaky tests?

### 14. Senior discussion
The app's E2E CI depends on a backend branch. What happens when backend and app change a contract in the same week, and how do you version the pairing?

---

## Chapter 6 — Mobile automation: emulators, Maestro, Detox, Appium

### 1. Why this exists
The customer app ships to phones; web runs don't catch native-only issues (permissions, secure storage, gestures, push).

### 2. Core concept
| Tool | Approach | Strength | Weakness |
| --- | --- | --- | --- |
| **Maestro** (used) | black-box YAML flows, mobile + web | simple, cross-platform, readable | less control, web support is beta |
| **Detox** | grey-box, React Native–aware, synchronises with the JS thread | fast, reliable for RN | RN-specific, more setup |
| **Appium** | WebDriver protocol for native apps | language-agnostic, broad | slower, more flaky |
| **Playwright** | browser automation | excellent for web | web only |

- **Emulator** (Android) / **simulator** (iOS) vs real devices (device farms).
- Native E2E needs a **development build** (not Expo Go) for things like secure storage behaviour.

### 3. Mental model
Choose the tool by *what you need to trust*: rendering in a browser (Playwright/Maestro web), native behaviour (Maestro/Detox on emulators), device diversity (device farm).

### 4. Delivery Plus mapping
- **CURRENT:** Maestro on the web build only.
- **NOT SET UP:** Android/iOS E2E (no Android SDK on the development machine; blocker B6 in `delivery-plus-customer-app/planning.md`). Flows already use platform-neutral `id:` selectors so they can run on native later.
- Networking caveat: `localhost` URLs (API and media) are unreachable from an Android emulator (`10.0.2.2` is the host) or a device — [Book 16](16-networking.md).

### 5. Example — the same `_shared/login.yaml` would run on Android once `APP_URL` is replaced by an `appId` and the app is built with a reachable API URL.
### 6. Failure scenario — secure-storage behaviour (`expo-secure-store` on native vs `localStorage` on web) differs; a web-only suite never tests the native session path.
### 7. Trade-offs — native runs are slower and need runners with emulators (macOS for iOS).
### 8. Performance — emulator boot is minutes; keep one emulator per job.
### 9. Security — native suites can test that tokens are not in plain storage.
### 10. Operations — device farms cost money per minute; reserve them for release candidates.

### 11. Lab
Plan (on paper) the Android job: emulator action, build command, API URL, Maestro command.

### 12. Verification
Your plan addresses the `localhost` problem explicitly.

### 13. Interview questions
- *Beginner:* Emulator vs simulator?
- *Intermediate:* Maestro vs Detox?
- *Advanced:* Why can't the emulator reach `localhost:3000`?
- *Senior:* Mobile test strategy for three apps with a small team.

### 14. Senior discussion
Maestro was chosen because it covers web and mobile with one syntax. Was that the right call given the web driver's limitations? What would make you switch?

---

## Chapter 7 — Designing the future Driver App and Restaurant flows (PLANNED)

Nothing in this chapter exists yet. The driver app (#99) and restaurant dashboard (#100) are planned; the rule in `delivery-plus-customer-app/planning.md` is that every new client ships with test IDs, a Maestro suite and CI from its first commit.

### Driver app — proposed suites
| Suite | Flow | Backend dependency |
| --- | --- | --- |
| smoke | sign in as `qa.driver`, go online | existing `POST /api/drivers/me/online` |
| smoke | receive the current delivery, see pickup and drop-off | `GET /api/deliveries/me/current` (#96), delivery address (#95), auto-dispatch (#97) |
| business | pickup → start → complete; customer app shows Delivered | existing delivery action endpoints (retry-safe) |
| regression | network loss during `complete`, retry succeeds | retry-safe delivery actions (CURRENT) |
| regression | a busy driver cannot go AVAILABLE | #33 |

### Restaurant dashboard — proposed suites
| Suite | Flow | Backend dependency |
| --- | --- | --- |
| smoke | sign in as `qa.restaurant`, see incoming orders | `GET /api/orders/restaurant/:restaurantId` |
| business | accept → preparing → ready; dispatch happens automatically | `PATCH /api/orders/:id/status`, #97 |
| regression | toggle an item unavailable; customer can't add it | `PATCH /api/menus/menu-items/:id/availability` |

### Cross-app business flow — target shape
```text
customer UI: order ──► restaurant UI: prepare, ready ──► (auto-dispatch) ──► driver UI: pickup, start, complete ──► customer UI: Delivered
```
Lab: [E2E-05 Design the driver app smoke suite](labs/e2e-labs.md#e2e-05-design-the-driver-app-smoke-suite).

---

[Library index](README.md) · Previous: [Book 12](12-testing-engineering.md) · Next: [Book 14 — Docker & Containers](14-docker-and-containers.md)
