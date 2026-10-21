# Driver Service

## Purpose
Tracks driver profiles, availability, and status transitions for delivery operations.

## Main REST endpoints
From `services/driver-service/src/controllers/drivers.controller.ts`:

- `POST /drivers/register` – register a driver profile for the authenticated driver
- `GET /drivers/me` – fetch the current driver profile
- `POST /drivers/me/online` – go online (OFFLINE → AVAILABLE); only a VERIFIED driver (`403 DriverNotVerified` otherwise, #206); not while BUSY
- `POST /drivers/me/offline` – go offline (AVAILABLE → OFFLINE); not while BUSY
- `POST /drivers/me/status` – same rules as the two routes above (ADMIN may use it for any valid transition)
- `GET /drivers/available` – list the drivers auto-dispatch may claim: AVAILABLE and VERIFIED (SYSTEM token only, #202)
- `PATCH /drivers/:id/verification` – admin review: `PENDING`, `VERIFIED` or `REJECTED` (ADMIN)
- `GET /drivers/:id` – fetch a driver by ID
- `PATCH /drivers/:id/status` – claim or release a driver (SYSTEM token only: delivery-service, #202)

## Dependencies
- Persists driver data in PostgreSQL
- Used by `delivery-service` to assign drivers and by `tracking-service` to resolve current driver information
- Reads the driver's own user-service profile when the phone verification gate is on

## Events published/consumed
None. Driver availability is changed synchronously by `delivery-service` (BUSY on assignment, AVAILABLE on completion or cancellation). The service used to also release drivers from `delivery.completed`/`delivery.cancelled`; that consumer was removed because a late event could free a driver who is already on the next delivery.

## Required env vars
From `services/driver-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `USER_SERVICE_URL` (default: `http://localhost:3002`)
- `PHONE_VERIFICATION_REQUIRED` (default `false`), see the phone verification gate
- `DRIVER_AUTO_VERIFY` (default `false`; test hook, **refused in production**): new driver profiles start `VERIFIED`. See the verification gate.
- `PORT` (default: `3009`)
- `NODE_ENV` (default: `development`)

## Phone verification gate (#153)

With `PHONE_VERIFICATION_REQUIRED=true`, going online (`POST /drivers/me/online`, OFFLINE → AVAILABLE) needs a verified phone: the caller's user-service profile must have `phoneVerifiedAt`. Otherwise the answer is `403` with error code `PhoneNotVerified`, which the apps answer with the verification step. The gate is **off by default** everywhere, including production. Turn it on only together with a real SMS provider in user-service (`SMS_PROVIDER`); otherwise nobody could verify.

## Driver profile and verification (#147)

- **Verification status:** `verificationStatus` is `PENDING` (default, also for drivers registered before #147), `VERIFIED` or `REJECTED`, plus an optional `verificationNote` for the driver and `verifiedAt`.
  - Only an admin sets it: `PATCH /drivers/:id/verification`. Admin review tooling is out of scope.
  - Since #206 it is binding: see the verification gate below.
- **Vehicle:** `PATCH /drivers/me/vehicle` (DRIVER) changes the vehicle type and plate (trimmed; the plate is upper-cased), **only while OFFLINE**, checked with a compare-and-set (409 otherwise). A change mid-shift would make the customer's driver card wrong for a job already on its way.
- **Name, phone and photo** belong to user-service (`PATCH /users/me` with the Egyptian phone rules of #152, and the avatar upload). driver-service doesn't copy them.
- **No identity documents.** The business does not require national-ID details today, so none are collected or stored, in line with the data-minimisation rule.
  - If that changes, they belong here only, restricted to the driver and admins.
  - They are never returned to customers and never copied into other services.
- Customers only ever see the delivery-service driver card (first name, photo, vehicle, plate); the verification fields are not part of it.

## Verification gate (#206)

Only a driver an admin has `VERIFIED` is ever put on the road:

- **Going online** (`me/online`, `me/status`, and an admin's `PATCH /drivers/:id/status` to AVAILABLE) is refused unless the driver is `VERIFIED`.
  - The answer is `403`, error code `DriverNotVerified`, with `details.verificationStatus` (`PENDING` or `REJECTED`), so the driver app can show "waiting for review" or "not approved".
  - It is checked before the phone gate.
- **Dispatch:**
  - `GET /drivers/available` returns only `AVAILABLE` and `VERIFIED` drivers.
  - The claim (AVAILABLE → BUSY) refuses a driver who isn't `VERIFIED` with `409`, so delivery-service moves on to the next driver.
  - The compare-and-set also requires `VERIFIED` at write time (`UPDATE … WHERE id = $1 AND status = $2 AND "verificationStatus" = 'VERIFIED'`). A driver rejected between the dispatcher's read and the claim is never assigned.
- **Rejection or re-review:** setting `REJECTED`, or `PENDING` on a re-review:
  - **While AVAILABLE:** the driver moves to `OFFLINE`. The verification is written first, so no claim or go-online can slip in between; then a compare-and-set moves AVAILABLE → OFFLINE.
  - **While BUSY:** the current job finishes. When delivery-service releases the driver (BUSY → AVAILABLE), driver-service writes `OFFLINE` instead, and the driver can't go online again.
- **Existing drivers:** migration 004 marks every `PENDING` driver that exists before #206 as `VERIFIED`. All of them are seeded or E2E accounts, since production starts empty. `REJECTED` drivers stay rejected.
- **Test stacks** (`DRIVER_AUTO_VERIFY=true`):
  - Seeds register new drivers on fresh databases, and no admin account exists to verify them until staff accounts arrive (#216, #234).
  - So `docker-compose.test.yml` (the Integration job and the E2E stack) and `docker-compose.dev.yml` make new profiles start `VERIFIED`.
  - Like `SMS_PROVIDER=test` and `PAYMENT_TEST_HOOKS`, the service refuses to start with it in production.
  - The root `docker-compose.yml` runs in production mode, so its drivers stay `PENDING` until an admin verifies them.

## Availability lifecycle

Statuses and allowed transitions (`DRIVER_TRANSITIONS` in `shared/src/types/enums.ts`):

```text
OFFLINE   → AVAILABLE, SUSPENDED
AVAILABLE → OFFLINE, BUSY, SUSPENDED
BUSY      → AVAILABLE, SUSPENDED
SUSPENDED → OFFLINE
```

Who may make each transition (`src/common/driver-transition-rules.ts`):

| Transition | Who | Route |
| --- | --- | --- |
| OFFLINE → AVAILABLE, AVAILABLE → OFFLINE | the driver (or ADMIN) | `me/online`, `me/offline`, `me/status` |
| AVAILABLE → BUSY (claim for a delivery) | SYSTEM only: delivery-service with its system token (#202) | `PATCH /drivers/:id/status` |
| BUSY → AVAILABLE (release after complete/cancel) | SYSTEM only: delivery-service with its system token (#202) | `PATCH /drivers/:id/status` |
| BUSY → OFFLINE (that release, for a driver who is no longer VERIFIED, #206) | SYSTEM only: delivery-service with its system token (#202) | `PATCH /drivers/:id/status` (asking for AVAILABLE) |
| → SUSPENDED, SUSPENDED → OFFLINE | ADMIN only | either |

Every change goes through one path in `DriversService`, in this order:

0. **Verification (#206):** going AVAILABLE needs `VERIFIED` (`403 DriverNotVerified`); a claim of a driver who isn't `VERIFIED` is a `409`.
1. **Repeated request:** asking for the current status is a no-op returning the driver (200) when that status is AVAILABLE or OFFLINE, so going online twice or releasing a driver twice is retry-safe. **BUSY is never a no-op:** claiming a BUSY driver is always a conflict.
2. **Transition exists?** Otherwise `409 InvalidStateTransition`.
3. **Role allowed?** Otherwise `403`. A driver who is BUSY gets *"Driver is on an active delivery; availability is restored when the delivery completes or is cancelled"*. Drivers cannot free themselves for a second delivery.
4. **Compare-and-set write** (`UPDATE … WHERE id = $1 AND status = <status read>`, plus `"verificationStatus" = 'VERIFIED'` for AVAILABLE and BUSY). If another writer changed the status in between, the loser gets `409`. Two assignments racing for one driver: exactly one claims them. A driver going offline while being claimed: exactly one of the two wins. If only the verification changed in between, the request is decided once more on the fresh row.

### Assignment failure and recovery

- **Lost claim:** delivery-service's `claimAvailableDriver` gets `409`, then tries the next available driver (up to 3), then answers `409 No available drivers to assign`.
- **Claim succeeded but recording the assignment failed:** delivery-service releases the claimed driver (`giveBackClaimedDriver`).
- **Complete/cancel:** delivery-service releases the driver first, idempotently. A repeated release is a no-op, and a driver who is no longer BUSY counts as released. It never releases a driver who is already on another active delivery.
- **Not covered here:** a driver left BUSY with no active delivery (for example, a crash between claim and assignment) needs reconciliation, which is not implemented. ADMIN can repair it with `PATCH /drivers/:id/status`.
