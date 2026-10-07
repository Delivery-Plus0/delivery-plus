# User Service

## Purpose
Owns user profiles and order-history lookups for authenticated users.

## Main REST endpoints
From `services/user-service/src/controllers/users.controller.ts`:

- `POST /internal/users` – internal profile creation endpoint
- `GET /users/me` – get the current authenticated profile
- `PATCH /users/me` – update the current authenticated profile
- `GET /users/me/orders` – fetch current user order history
- `GET /users/:id` – get a user profile by ID (own profile or admin)
- `POST /users/me/avatar/image-upload-url` – create a short-lived presigned avatar POST policy
- `POST /users/me/avatar/confirm` – verify the uploaded object and save its public URL
- `DELETE /users/me/avatar` – remove the current photo (#150)
- `POST /users/me/phone/verification` – text a one-time code to the current phone, or to `{ phone }` for a phone change (#153)
- `POST /users/me/phone/verify` – confirm `{ code }`; the number becomes the verified profile phone (#153)

## Phone numbers (#152)

Profiles store only **Egyptian mobile numbers in E.164** (`+201XXXXXXXXX`, networks 010/011/012/015). `POST /users`, `PATCH /users/me` and auth registration accept any common form (`01092784342`, `+20 1092784342`, `0020-109-278-4342`, with spaces, dashes, dots or parentheses) and normalize it with the shared `normalizeEgyptianMobile()` / `@EgyptianMobile()`; anything else (landlines, other countries, wrong length) is a 400 with a clear message. Migration 004 normalized existing phones and cleared invalid ones, logging only how many. The apps use the same rules and the same case table.

## Phone verification (#153)

A profile's phone is **verified** when `phoneVerifiedAt` is set, and only a confirmed one-time code sets it.

How a code works:

- **Code:** six digits from `crypto.randomInt`. Only an HMAC-SHA256 of it is stored (`phone_verifications.codeHash`), keyed with `OTP_HASH_SECRET` and bound to the row id. It is never logged.
- **Expiry:** 5 minutes.
- **Attempts:** at most 5 wrong codes. Each attempt is counted atomically, and once they run out even the right code is refused.
- **Single use:** a correct code is consumed and the profile updated in one transaction (compare-and-set on `consumedAt`). Only the latest code sent to a user can be verified.

Sending limits, checked under a per-user Postgres advisory lock so concurrent requests can't slip past them:

- a resend waits 60 seconds;
- at most 5 codes per hour per user;
- at most 5 codes per hour per number.

A refused send is a `429` with a message saying how long to wait.

To change the phone, call `POST /users/me/phone/verification` with the new `{ phone }`. It is normalized like everywhere else (#152), and the profile switches to it only after the code is confirmed. `PATCH /users/me` can still set a phone, but a different number is stored **unverified** (`phoneVerifiedAt: null`).

SMS goes through the `SmsSender` port (`src/sms/sms-sender.ts`). No real provider is implemented yet, and `SMS_PROVIDER` decides what runs:

- `disabled` (the default, including production): verification answers `503`. Nothing pretends a code was sent.
- `test`: for isolated test stacks only (`docker-compose.test.yml`), and refused at startup in production. Each message is kept in Redis under `test:sms:<E.164>` for 15 minutes, so E2E suites can read the code. `scripts/e2e.ts` covers the whole flow this way.

If the message can't be sent, its row is deleted, so the attempt neither counts against the limits nor blocks a retry. Ordering and going online can then require a verified phone: see the `PHONE_VERIFICATION_REQUIRED` gate in order-service and driver-service. Adding a real provider means a new `SmsSender` implementation, an `SMS_PROVIDER` value, and credentials from the environment.

## Dependencies
- Calls `order-service` to fetch order history via `src/common/order-service.client.ts`
- Depends on PostgreSQL for the user profile table
- Uses the shared S3 storage service for avatar objects; the image key is scoped to the authenticated profile ID
- Trusted by `auth-service` on registration

## Events published/consumed
- No Kafka event producer/consumer is implemented in this service.

## Required env vars
From `services/user-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `ORDER_SERVICE_URL` (default: `http://localhost:3006`)
- `REDIS_URL` (default: `redis://localhost:6379`)
- `INTERNAL_AUTH_SECRET` (required in production; local Compose provides a development-only default)
- `SMS_PROVIDER` (default `disabled`; `test` only outside production, see Phone verification)
- `OTP_HASH_SECRET` (keys the stored code hashes; required in production once `SMS_PROVIDER` is not `disabled`)
- `PORT` (default: `3002`)
- `NODE_ENV` (default: `development`)
- `AWS_REGION`, `AWS_S3_BUCKET`, and `AWS_PUBLIC_BASE_URL`; S3 endpoint and credentials are configurable for the local media-storage service (SeaweedFS's S3 gateway) or a cloud provider

## Notes
The service acts as the canonical user-data layer for profile details. `POST /internal/users` requires the HMAC internal-auth contract in [ADR 001](../adr/001-internal-service-authentication.md) and records the verified caller in `createdByService`. Redis stores short-lived nonces with `SET NX EX` so a signed request cannot be replayed within the acceptance window. Profile rows store an explicit `authCredentialId` that must equal the profile `id` (the auth-service credential UUID). `GET /users/:id` is limited to the owning user or an admin. `GET/PATCH /users/me` and `GET /users/me/orders` require the JWT subject and email to match the stored profile.

Avatar uploads use a five-minute presigned POST policy and allow JPEG, PNG, or WebP up to 5 MiB. Clients POST multipart form data to `uploadUrl`, including every returned `fields` entry and the image file. The policy enforces the size limit before storage accepts the upload. Confirmation rechecks the authenticated profile, validates the staging key under `pending/users/{userId}/avatar/`, checks the image bytes, copies the object to a separate permanent key, then persists `avatarUrl`. Staging objects expire after one day. The field is nullable and was added with a forward TypeORM migration.
