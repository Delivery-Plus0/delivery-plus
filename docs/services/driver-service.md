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

Driver application (#207, see below):

- `GET /drivers/me/application` – your application: status, fields, documents (never a URL) and what is missing (DRIVER)
- `PUT /drivers/me/application` – save the national ID and the two licence expiry dates (DRIVER, draft only)
- `POST /drivers/me/documents/:type/upload-url` – a presigned POST for one document (DRIVER, draft only, 20 an hour)
- `POST /drivers/me/documents/:type/confirm` – check the upload and make it the document's current version (DRIVER, draft only, 30 an hour)
- `POST /drivers/me/application/submit` – send a complete draft to the review queue (DRIVER)
- `GET /drivers/:id/application` – a driver's application (staff with `onboarding.review`)
- `POST /drivers/:id/documents/:type/read-url` – a 5-minute URL to view a document; every read is recorded (staff with `onboarding.review`, 60 a minute)

## Dispatch fairness (#210)

Available, VERIFIED drivers are listed by `COALESCE(availableSince, updatedAt) ASC, id ASC`: the longest-idle driver is offered work first, with a deterministic tie-breaker. Going online or being released from a delivery records database time in the same compare-and-set update as the status. Leaving AVAILABLE clears the timestamp. Repeated online/release requests are no-ops and retain the current queue position; unrelated profile or verification edits do not change it.

Migration 005 backfills existing AVAILABLE drivers from `updatedAt` (the best historical approximation), leaves other drivers null, and adds a partial queue index. Driver profile responses include nullable ISO timestamp `availableSince`. During a rolling deploy, old instances can still write AVAILABLE rows without an idle timestamp. The read side uses updatedAt as the historical fallback for a missing availableSince, so legacy drivers participate by time rather than being grouped and selected by id. The id only breaks exactly equal effective timestamps. Migration 006 replaces the partial queue index with a matching COALESCE expression index; apply migrations 005 and 006 before the new code. Each successful delivery release moves that driver behind the other waiting drivers.

Queue accounting follows status, not the delivery outcome: every successful BUSY → AVAILABLE release starts a new idle period. This includes a failed assignment being rolled back and a delivery cancelled before pickup; the previous position is not restored. This documents the implemented baseline, not a special compensation policy. A claim rejected by compare-and-set never changes the timestamp, and a repeated release/online request is a no-op. Restoring pre-claim positions would require a separate owner-approved rule and storage/contract change.

The delivery-service claim/retry loop and VERIFIED gate are unchanged. Its internal client re-reads page 1, limit 1 after a lost claim, rather than incrementing an offset and skipping the new head. A future atomic claim with SKIP LOCKED is separate work. This is the fair baseline; nearest-driver selection is a later issue.

## Dependencies
- Persists driver data in PostgreSQL
- Stores driver documents in a private S3-compatible bucket (#207) and uses Redis for rate limits
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
- `DRIVER_DOCUMENTS_BUCKET` (#207; **required in production**, local default `delivery-plus-private`): the private documents bucket, never the public media bucket.
- `NATIONAL_ID_HMAC_SECRET` (#207; no default outside development and test; at least 32 characters and different from the JWT secrets in production).
- `REDIS_URL` (default `redis://localhost:6379`): the upload and staff read rate limits.
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_ENDPOINT`, `AWS_S3_PUBLIC_ENDPOINT`, `AWS_S3_FORCE_PATH_STYLE`: the object storage connection, shared with the media services.
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
- **Identity documents** are part of the driver application (#207, below). They live here only, in a private bucket, readable by staff with `onboarding.review`; they are never returned to customers and never copied into other services.
- Customers only ever see the delivery-service driver card (first name, photo, vehicle, plate); the verification fields are not part of it.

## Driver application (#207)

An admin can't approve a driver they know nothing about, so a driver now applies with their national ID, licence dates and five documents before review. This is the first part of #207: application data, private documents and submit. Reviews with history and resubmission after a rejection, and the nightly expiry check, follow in the next pull requests.

### Status

There is no new status column. The application status is derived from the verification status and `submittedAt`, and the API returns it as `status`:

| `verificationStatus` | `submittedAt` | Application `status` | The driver can |
| --- | --- | --- | --- |
| `PENDING` | null | `DRAFT` | edit fields, upload documents, submit |
| `PENDING` | set | `SUBMITTED` (in the review queue) | wait |
| `VERIFIED` | any | `VERIFIED` | drive |
| `REJECTED` | any | `REJECTED` | read the note (resubmission comes with the reviews PR) |

Only a draft can change: every write is a compare-and-set or runs under a row lock on the driver that checks it is still a draft (`409 ApplicationNotEditable` with `details.applicationStatus` otherwise). A document confirmed while the driver submits either lands before the submit or is refused. Migration 007 adds only nullable columns, so existing drivers keep their status: verified drivers stay on the road, and pending ones become drafts.

### Application fields

`PUT /drivers/me/application` takes `nationalIdNumber` (14 digits, Egyptian), `drivingLicenceExpiresOn` and `vehicleLicenceExpiresOn` (`YYYY-MM-DD`, real dates, not past in Cairo time, at most 15 years ahead).

- **The national ID number is never stored.** The service keeps its last four digits and an HMAC-SHA256 of it under `NATIONAL_ID_HMAC_SECRET` (no default outside development and test). The hash is unique, so one ID can back only one driver account (`409 NationalIdAlreadyRegistered`). Neither column is selected by default; the hash is never returned, and the last four digits appear only in the application view.
- The dates are calendar dates in Cairo.

### Documents

Five types, each required: `national-id-front`, `national-id-back`, `driving-licence`, `vehicle-licence`, `selfie`. JPEG, PNG or PDF, up to 10 MB.

1. `POST /drivers/me/documents/:type/upload-url` with `{ "contentType": … }` returns a presigned POST (`uploadUrl`, `fields`, `objectKey`, five minutes). The key is `pending/drivers/{driverId}/{type}/{uuid}.{ext}`, fixed by the policy together with the exact content type and a 1 byte to 10 MB size range. The client never chooses a key.
2. The app posts the file straight to the bucket.
3. `POST /drivers/me/documents/:type/confirm` with `{ "objectKey": … }`: the key must be under the caller's own prefix for that type; the object's size and the metadata the policy issued are checked; its bytes must really be a JPEG, PNG or PDF matching the declared type (magic bytes). It is then copied to `drivers/{driverId}/documents/{type}/{uuid}.{ext}` with `Cache-Control: no-store`, and recorded as the type's new current version. A retried confirm of the same upload returns the same version.

Replacing a document adds a version and keeps the previous one, for the review that used it. Each type keeps at most 5 versions (`409 DocumentVersionLimitReached`, enforced in the database too). The tables:

- `driver_documents`: driver, type, version, `isCurrent` (one current version per type), object key, content type, size, SHA-256, upload time. Deleted with the driver (foreign key, `ON DELETE CASCADE`).
- `driver_document_access`: every staff read (staff user id, driver, document id, type, version, time). Append-only, no foreign keys, so it outlives the document. It stands in until audit-service exists (#213).

Only the object key is stored. **No URL is ever stored, logged or returned to the driver.**

### Submit

`POST /drivers/me/application/submit` sets `submittedAt` once every field and all five documents are present and neither licence has expired. Otherwise `422 ApplicationIncomplete` with `details.missingFields`, `details.missingDocuments` and `details.expiredLicences`. The application view's `canSubmit` says the same in advance.

### Staff access

`GET /drivers/:id/application` and `POST /drivers/:id/documents/:type/read-url` need an ADMIN token holding `onboarding.review` (#202); every other caller, including the driver, gets `403`.

The read URL is a presigned GET that lives 5 minutes, with `response-cache-control=no-store`, and the response itself carries `Cache-Control: no-store`. The read is recorded in `driver_document_access` **before** the URL is signed: if the record can't be written, no URL is issued.

### Storage and privacy

- Documents live in their own private bucket, `DRIVER_DOCUMENTS_BUCKET`: no bucket policy, Block Public Access on, SSE-S3. The service refuses to start in production without it, and refuses the public media bucket's name. Local and test stacks create `delivery-plus-private` with no policy.
- Unconfirmed uploads expire with the bucket's one-day lifecycle rule on `pending/`. The issue sketched the quarantine as `drivers/{id}/pending/…`; S3 lifecycle rules filter on a key prefix, so the quarantine is one top-level `pending/` prefix instead, which one rule covers.
- Retention (working default, to confirm before launch): documents of a driver finally rejected are kept 90 days; an approved driver's documents live as long as the account and are deleted with it (#233). Replaced versions are kept with the review that used them for the same period. The deletion jobs come with #233 and the retention follow-up.
- IAM and bucket setup: [deployment.md](../deployment.md).

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
