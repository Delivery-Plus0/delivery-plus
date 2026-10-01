# E2E / UI Automation Labs

[Lab index](README.md) · Books: [12 Testing Engineering](../12-testing-engineering.md), [13 E2E / UI Automation](../13-e2e-ui-automation.md)

Prerequisites: Docker, Node 22, Java 17 and the Maestro CLI (see `delivery-plus-customer-app/e2e/README.md`), both repositories cloned side by side:
```text
open-source/
├── delivery-plus/                  backend (E2E environment, seed:e2e)
└── delivery-plus-customer-app/     customer app (Maestro flows, runner)
```

---

## E2E-01 Reset and inspect the E2E environment

```bash
cd delivery-plus
npm run e2e:env:reset                       # down -v → up --build --wait → seed:e2e
docker compose -p delivery-plus-e2e ps --format 'table {{.Name}}\t{{.Status}}'
curl -s localhost:3100/health ; echo
node -e 'const m=require("./e2e-seed-manifest.json"); console.log(Object.keys(m), m.accounts, Object.keys(m.orders))'
docker compose -p delivery-plus-e2e exec postgres psql -U postgres -d order_service -c "SELECT status, count(*) FROM orders GROUP BY 1;"
```
**Expected:** every container healthy with 0 restarts; the gateway on `:3100` (the dev stack on `:3000` can run at the same time); the manifest lists the QA accounts (`qa.customer`, `qa.customer2`, `qa.restaurant`, `qa.driver` @ `delivery-plus.test`) and the scenario orders (delivered, failed, awaiting driver, other customer).
**Run it twice:** IDs differ, structure is identical — deterministic data, not identical rows.
**Links:** `docs/e2e.md`, [case study 15](../case-studies/15-e2e-environment.md).

---

## E2E-02 Customer login and checkout

```bash
cd delivery-plus-customer-app
npm ci
node e2e/scripts/run.mjs --suite smoke --build --headless
ls e2e/.artifacts/smoke
```
**Expected:** four smoke flows pass (`01-login`, `02-browse`, `03-cart`, `04-checkout`); a JUnit report (`<flow>.junit.xml`) plus Maestro test and debug output per flow under `e2e/.artifacts/smoke/`.
**Read while it runs:** `e2e/flows/smoke/04-checkout.yaml` — test IDs (`add-QA Fries`, `cart-subtotal`), the regex text assertion `'\$7\.00'`, and the explicit waits.
**Why the build step:** the API URL (`EXPO_PUBLIC_API_BASE_URL=http://localhost:3100`) is baked into the web build; the runner exports with `--clear` so a warm Metro cache can't keep an old URL.

---

## E2E-03 Failure screenshot and offline recovery

1. Break an assertion on purpose: in `e2e/flows/smoke/03-cart.yaml` change an expected subtotal (e.g. `\$20\.00` → `\$21\.00`).
2. `node e2e/scripts/run.mjs --suite smoke --headless` (no `--build` needed if nothing in `src/` changed).
3. Open the failing flow's screenshot and debug output in `e2e/.artifacts/smoke/`; read the JUnit failure message.
4. Revert the change.
5. Run the offline flow: `node e2e/scripts/run.mjs --suite regression --headless` and read `e2e/flows/regression/offline-recovery.yaml`.

**Expected:** the screenshot shows the real subtotal the assertion didn't match; the offline flow stops the E2E gateway through the runner's control server (`gateway/stop`), sees the offline state, restarts it (`gateway/start`) and recovers **without** signing in again.
**Links:** [Book 13 Ch. 4](../13-e2e-ui-automation.md#chapter-4--authentication-stand-ins-fault-injection-and-isolation), [Book 26 Ch. 4](../26-reliability-engineering.md#chapter-4--graceful-degradation-and-recovery).

---

## E2E-04 Full business-flow validation

```bash
node e2e/scripts/run.mjs --suite business --headless
```
Read `e2e/flows/business/customer-order-lifecycle.yaml` alongside the run and fill this table:

| Step | Real UI or API stand-in? | Control action / UI element | Future client that replaces the stand-in |
| --- | --- | --- | --- |
| customer places the order | UI | `checkout-place-order` | — |
| restaurant prepares, marks ready | stand-in | `restaurant/prepare`, `restaurant/ready` | restaurant dashboard (#100) |
| delivery created and assigned | stand-in | `restaurant/dispatch` | automatic dispatch (#97) |
| pickup, start, complete | stand-in | `driver/pickup`, `driver/start`, `driver/complete` | driver app (#99) |
| customer sees each stage and "Delivered" | UI (polling every 10 s) | `delivery-stage`, `order-status` | — |
| confirmation notification visible | UI | `/notifications` page, text `…has been confirmed.` | — |

**Expected:** the flow passes; your table matches the file. Note the timeouts (up to 30 s) — they exist because the app *polls* every 10 s rather than being pushed updates.
**Discuss:** what does this test prove today, and what can't it prove while three of its actors are stand-ins? ([Book 12 Ch. 5](../12-testing-engineering.md#chapter-5--api-vs-business-flow-vs-ui-tests))

---

## E2E-05 Design the driver app smoke suite

No driver app exists yet (issue #99). Write — on paper or in a scratch branch — the Maestro flows its first commit should ship with:
1. `_shared/login-driver.yaml` (sign in as `qa.driver@delivery-plus.test`).
2. `smoke/01-go-online.yaml` — `POST /api/drivers/me/online` through the UI; assert the online badge.
3. `smoke/02-current-delivery.yaml` — depends on `GET /api/deliveries/me/current` (#96) and the drop-off address (#95).
4. `business/deliver.yaml` — pickup → start → complete; then assert in the **customer** app that the order is Delivered (cross-app).
5. `regression/network-drop-on-complete.yaml` — use the control server to stop the gateway during `complete`; on restart the retry succeeds (delivery actions are retry-safe).
6. `regression/busy-cannot-go-available.yaml` — depends on #33.

**Deliverable:** for each flow, list its test IDs, the seed data it needs (extend `scripts/seed-e2e.ts`), and the backend contract it depends on.
**Links:** [Book 13 Ch. 7](../13-e2e-ui-automation.md#chapter-7--designing-the-future-driver-app-and-restaurant-flows-planned).

---

[Lab index](README.md)
