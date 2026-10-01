# E2E environment

An isolated, throw-away copy of the platform for UI automation (Maestro suites live in each client
repo, e.g. `delivery-plus-customer-app/e2e`).

| | Dev stack | E2E stack |
| --- | --- | --- |
| Compose project | `delivery-plus` | `delivery-plus-e2e` (own containers, network, volumes) |
| Files | `base` + `dev` | `base` + `test` + `e2e` |
| Gateway | `:3000` | `:3100` |
| Object storage | `:9000` | `:9100` (public media URLs point here) |
| Payments | 90% succeed at random | always succeed (`PAYMENT_SUCCESS_RATE=1`) |

Both stacks can run at the same time.

## Commands

```bash
npm run e2e:env:up      # build + start, wait until healthy
npm run seed:e2e        # deterministic accounts, catalog and order scenarios; writes e2e-seed-manifest.json
npm run e2e:env:down    # stop and delete the E2E volumes
npm run e2e:env:reset   # down → up → seed (reproduce from scratch)
```

`seed:e2e` (`scripts/seed-e2e.ts`) goes through the gateway only, uses the test-only password from
`E2E_PASSWORD` (default `Qa-Only-Passw0rd!`), refuses non-localhost targets unless
`E2E_ALLOW_REMOTE=1`, and is rerunnable (existing accounts, catalog and scenarios are reused). The
manifest (git-ignored) carries the generated ids that UI flows need.

Seeded data: see `scripts/seed-e2e.ts` (`QA` accounts, `QA Kitchen` / `QA Night Cafe`, scenarios
S1 delivered, S2 payment declined, S3 ready for pickup without a delivery, S4 another customer's
confirmed order).
