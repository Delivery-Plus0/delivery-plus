# Auth Service

## Purpose
Handles registration, authentication, sessions and JWT-based identity for users and roles.

## Main REST endpoints
From `services/auth-service/src/controllers/auth.controller.ts`:

- `POST /auth/register` – register a new user and create a profile. `role` is optional and limited to `CUSTOMER` (default), `RESTAURANT_OWNER` or `DRIVER`; `ADMIN` is rejected (400 in validation, 403 in the service), so the role is server-controlled.
  - Email verification off (default): signs in, same response as login.
  - `EMAIL_VERIFICATION_REQUIRED=true`: `201 { userId, verificationRequired: true }` and **no tokens**. The user verifies the email, then logs in.
- `POST /auth/login` – sign in: an access token and a refresh token (see [Sessions](#sessions-34)).
- `POST /auth/refresh` – exchange a refresh token for a new pair.
- `POST /auth/logout` – sign out this device (ends the session of a refresh token).
- `POST /auth/logout-all` – sign out every device (access token required).
- `POST /auth/verify-email`, `POST /auth/resend-verification` – email verification by a 6-digit code (see [Email verification](#email-verification-203)).
- `POST /auth/password/change`, `POST /auth/password/forgot`, `POST /auth/password/reset` – change the password while signed in, or reset it with an SMS code (see [Password change and reset](#password-change-and-reset-35)).
- `GET /auth/me` – return the current user payload from the bearer token.
- `PATCH /auth/users/:id/status` – suspend or reactivate an account (staff with `users.manage`, see [Account status](#account-status-202)).

Internal only (blocked at the gateway, HMAC per ADR 001), from `src/controllers/internal-sessions.controller.ts`:

- `POST /internal/auth/users/:id/revoke-sessions` – end a user's refresh sessions (see [Revoking sessions from other services](#revoking-sessions-from-other-services)).

## Sessions (#34)

Sign-in gives two tokens:

| Token | What it is | Lifetime | Where it goes |
| --- | --- | --- | --- |
| Access token | JWT (`sub`, `email`, `role`, `sid`) signed with `JWT_SECRET` | `JWT_EXPIRES_IN`, **15 minutes** by default | `Authorization: Bearer` on every API call, as before |
| Refresh token | Opaque `<sessionId>.<secret>` | `REFRESH_TOKEN_TTL_DAYS` (30) after its **last use** (sliding) | Only `POST /auth/refresh` and `POST /auth/logout` |

The response of login, register (verification off) and refresh:

```json
{
  "accessToken": "eyJ…",
  "accessTokenExpiresAt": "2026-10-20T10:15:00.000Z",
  "refreshToken": "6f0c…-…-….Zm9vYmFy…",
  "refreshTokenExpiresAt": "2026-11-19T10:00:00.000Z",
  "userId": "…",
  "email": "…",
  "role": "CUSTOMER"
}
```

Login and register accept an optional `appId` (`customer`, `driver`, `restaurant`, `admin`); it is recorded on the session with the `User-Agent` (truncated to 255 characters).

**Storage.** One row per sign-in in `auth_sessions` (auth-service Postgres): `id` (the token family), `credentialId`, `refreshTokenHash`, `previousTokenHash`, `expiresAt`, `revokedAt`, `revokedReason`, `createdAt`, `lastUsedAt`, `userAgent`, `appId`. Only `sha256(secret)` is stored. Deleting a credential deletes its sessions.

**Refresh** (`POST /auth/refresh { refreshToken }` → 200, same shape as login):

- The session is found by the id in the token and the secret's hash is compared in constant time.
- The token **rotates** in one compare-and-set `UPDATE` (current → previous, new → current, `lastUsedAt`, `expiresAt` = now + 30 days). Of two refreshes with the same token, exactly one wins.
- The role is read again from the credential, so a role change applies from the next access token.
- **Reuse detection:** presenting the token a refresh replaced **revokes the whole session** (`reuse_detected`); both the thief's and the user's copies stop working. A wrong secret for a real session is refused without revoking it.
- Every failure (unknown, malformed, expired, revoked, reused) is the same `401 InvalidRefreshToken`, so the client's only action is to sign in again.
- Rate limited to 10 per minute **per session** (`@RateLimit` with a `key`), not per IP: behind the gateway every client has the gateway's IP.

**Logout** (`POST /auth/logout { refreshToken }` → always `204`): ends that session. The live token and the one it replaced both count, so a client that missed a refresh response can still sign out. Unknown tokens also get 204.

**Logout everywhere** (`POST /auth/logout-all`, access token → `204`): ends every session of the user.

**Access tokens are not revoked.** They stay valid until they expire (15 minutes). Revoking a session stops the next refresh, which is the decision recorded in #34 and #35.

**Cleanup.** Every `SESSION_CLEANUP_INTERVAL_MS` (1 hour; 0 disables), sessions that expired or were revoked more than `SESSION_RETENTION_DAYS` (30) ago are deleted. The DELETE is idempotent, so every replica can run it.

### Client contract

- Store the refresh token securely (Keychain / Keystore / `expo-secure-store`); never put it in a URL or a log.
- On `401` from any API with an expired access token, call `POST /auth/refresh` **once**, replace **both** tokens, and retry. Refresh proactively shortly before `accessTokenExpiresAt` if convenient.
- **Single-flight:** never send two refreshes with the same refresh token. Queue concurrent 401s behind one refresh. A second refresh with the same token counts as reuse and signs the user out everywhere that session was used.
- `401 InvalidRefreshToken` from refresh means the session is over: clear both tokens and show sign-in.
- Sign out: `POST /auth/logout` with the refresh token, then clear both tokens (even if the call fails).

### Revoking sessions from other services

`POST /internal/auth/users/:id/revoke-sessions` with the HMAC headers of ADR 001 (`x-internal-service`, `x-internal-timestamp`, `x-internal-nonce`, `x-internal-signature`):

- Body: `{ "reason": "password_changed" | "password_reset" | "suspended" | "admin", "exceptSessionId"?: "<uuid>" }`.
- Response: `200 { "revoked": <number of sessions ended> }`.
- Only services listed in `AUTH_INTERNAL_ALLOWED_SERVICES` may call it (empty by default: nobody). `401` for a missing, wrong, expired or replayed signature or a caller not on the list; `400` for another reason or a malformed id.
- Inside auth-service (#35's password change and reset, #202's suspension) call `SessionsService.revokeAll(credentialId, reason, exceptSessionId?)` directly. The current session's id is the access token's `sid` claim.

## Email verification (#203)

- **Sending:** registration emails a **6-digit code**, and `POST /auth/resend-verification { email }` sends a new one. The user sends it back as `token` to `POST /auth/verify-email { email, token }`.
- **The code:**
  - it works **once**, for **10 minutes** (`VERIFICATION_TOKEN_TTL_MINUTES`);
  - the **5th wrong code** (`VERIFICATION_MAX_ATTEMPTS`) invalidates it;
  - it's stored only as an HMAC under `EMAIL_CODE_HASH_SECRET`, bound to the account, and compared in constant time;
  - it never appears in logs or responses.
- **Resend limits:** one email a minute per address (`VERIFICATION_RESEND_COOLDOWN_SECONDS`), 5 an hour per address, and 20 an hour per client IP.
  - The limits are counted whether or not the address has an account, so the `429` and the generic answer reveal nothing.
  - Registration counts as the first send.
- **Language:** the email is multipart (text and HTML), in Arabic (right to left) or English from `Accept-Language` (Arabic by default, like the apps).
- **Senders (`EMAIL_PROVIDER`):**
  - `disabled` (default): nothing is sent, and resend answers `503 EmailUnavailable`.
  - `test`: the last email per address goes to Redis (`test:email:<address>`) for E2E runs. Refused in production.
  - `ses`: Amazon SES (SESv2 `SendEmail`), credentials from the AWS provider chain only. One retry on throttling or 5xx, none on 4xx or timeout. Failures are `503 EmailUnavailable` without provider details; logs carry the correlation id, never the address or the code. Setup: [docs/runbooks/email-ses.md](../runbooks/email-ses.md).
- **Registration never fails because of email:** the account exists, and the user can ask for a new code.
- **Production refuses:** `EMAIL_PROVIDER=test`; `ses` without `AWS_REGION`/`SES_FROM_ADDRESS`; `EMAIL_VERIFICATION_REQUIRED=true` with `disabled`; a provider without a real `EMAIL_CODE_HASH_SECRET`.
- **Old codes:** codes issued before #203 were never emailed. Migration 006 clears them, and those users ask for a new one.

## Account status (#202)

- `credentials.status` is `ACTIVE` (default) or `SUSPENDED`, with `suspendedAt` and `suspendedReason`.
- **Suspended accounts:**
  - `POST /auth/login` answers `403 AccountSuspended`, but only after the password checked out. A wrong password stays `401`, so a stranger learns nothing.
  - `POST /auth/refresh` answers `403 AccountSuspended` too, including for a session the suspension ended, so the apps can show the suspended screen.
- **Suspending** ends every refresh session (`revokedReason: suspended`). Access tokens already issued expire within `JWT_EXPIRES_IN`.
- **Reactivating** restores login. The sessions the suspension ended stay ended.

**Unverified email (#252).** While `EMAIL_VERIFICATION_REQUIRED=true`, `POST /auth/login` answers `403 EmailNotVerified` for an account whose email isn't verified yet, again only after the password checked out (a wrong password stays `401`). The apps open their code screen. `POST /auth/verify-email` keeps one `401` for every failure: a wrong, expired, used or exhausted code and an unknown email look the same, so the endpoint can't be used to find accounts.
- **`PATCH /auth/users/:id/status`** `{ status, reason? }` → `200 { userId, status, suspendedAt, suspendedReason, sessionsRevoked }`.
  - It needs an ADMIN token with `users.manage`.
  - `403` for your own account, for a staff account (staff are managed with the staff tools, #216), or without the permission; `404` for an unknown user.
  - This is the minimal staff action the admin console (#215) builds on.

## Staff permissions (#202)

- Staff have role `ADMIN`. What each person may do is in `staff_permissions` (`credentialId`, `permission`).
- **The ten permissions:** `support.read`, `support.act`, `ops.read`, `ops.act`, `finance.read`, `finance.act`, `onboarding.review`, `users.manage`, `staff.manage`, `audit.read` (`STAFF_PERMISSIONS` in `shared`).
- **In tokens:** staff access tokens carry `perms`, read fresh at every login and refresh, so a change applies within one access-token lifetime. Other tokens carry none.
- **Enforcement:** routes require permissions with `@RequirePermissions(...)` and `PermissionsGuard` from `shared`. `perms` on a non-staff token is ignored.
- **The first super admin** (every permission) is created out of band: see [docs/runbooks/bootstrap-admin.md](../runbooks/bootstrap-admin.md).
  - Test and dev stacks create theirs at startup from `TEST_ADMIN_EMAIL` and `TEST_ADMIN_PASSWORD`; auth-service refuses those variables in production.

## Password change and reset (#35)

- **Change** (`POST /auth/password/change { currentPassword, newPassword }`, access token → `204`):
  - A wrong current password (or a locked account) is `400 CurrentPasswordIncorrect` and counts as a failed sign-in attempt. It is not a `401`: the apps take a `401` on a signed-in call as an expired session (refresh, replay, then sign out). A suspended account is `403 AccountSuspended`, checked only after the current password is verified.
  - A new password equal to the current one is `400`.
  - On success every **other** session ends (`revokedReason: password_changed`); the session of the access token (`sid`) stays signed in. Limited to 5 a minute per user.
- **Forgot** (`POST /auth/password/forgot { phone }`, public → `202 { message }`):
  - The code goes by SMS to the account's **verified** phone. user-service owns the phone and the code; auth-service owns the password.
  - The answer is the same whether or not the phone has an account. Limits: 5 a minute per client, 20 an hour per client IP and 5 an hour per phone, counted for every phone (phones are hashed in the Redis keys), so a `429` reveals nothing.
  - `503 SmsUnavailable` for everyone while SMS isn't set up.
- **Reset** (`POST /auth/password/reset { phone, code, newPassword }`, public → `204`):
  - auth-service asks user-service to consume the code (single use, 5 attempts, 5 minutes). Every failure (wrong, expired, used, exhausted, unknown phone) is one generic `401`.
  - A suspended account is `403 AccountSuspended`. On success the hash changes, the failed-login lockout clears and **every** session ends (`revokedReason: password_reset`). Limited to 10 a minute per client.
- **Password policy:** same as registration (minimum 8 characters), for change and reset.
- Raw codes, phone numbers and passwords never appear in logs. As elsewhere, access tokens already issued stay valid until they expire.

## Dependencies
- Calls `user-service` internally for user profile creation via `src/common/user-service.client.ts`, signing the request with the internal HMAC contract, and for password reset codes (`POST /internal/users/password-reset/send` and `/verify`, same HMAC contract)
- Requires `DATABASE_URL` and `JWT_SECRET`
- Redis: rate limits and the internal-auth nonces

## Events published/consumed
- No Kafka producers or consumers are implemented in this service.

## Required env vars
From `services/auth-service/src/config/app-config.ts` and `docker-compose.yml`:

- `DATABASE_URL`
- `JWT_SECRET`
- `JWT_EXPIRES_IN` (default: `15m`; access-token lifetime)
- `REFRESH_TOKEN_TTL_DAYS` (default: `30`; sliding refresh-session lifetime)
- `SESSION_CLEANUP_INTERVAL_MS` (default: `3600000`; `0` disables the cleanup job)
- `SESSION_RETENTION_DAYS` (default: `30`; how long ended sessions are kept before deletion)
- `AUTH_INTERNAL_ALLOWED_SERVICES` (default: empty; comma-separated services allowed to call `/internal/auth/*`)
- `USER_SERVICE_URL` (default: `http://localhost:3002`)
- `PORT` (default: `3001`)
- `NODE_ENV` (default: `development`)
- `INTERNAL_AUTH_SECRET` (required in production; local Compose provides a development-only default)
- `EMAIL_VERIFICATION_REQUIRED` (default: `false`)
- `EMAIL_PROVIDER` (`disabled` default, `test`, `ses`), `EMAIL_CODE_HASH_SECRET` (required in production with a provider)
- For `ses`: `AWS_REGION`, `SES_FROM_ADDRESS`, optional `SES_CONFIGURATION_SET`, `EMAIL_SEND_TIMEOUT_MS` (default `5000`)
- `VERIFICATION_TOKEN_TTL_MINUTES` (default `10`), `VERIFICATION_MAX_ATTEMPTS` (default `5`), `VERIFICATION_RESEND_COOLDOWN_SECONDS` (default `60`)
- `TEST_ADMIN_EMAIL`, `TEST_ADMIN_PASSWORD` (test and dev stacks only; refused in production): the super admin created at startup
- For the bootstrap CLI only: `BOOTSTRAP_ADMIN_EMAIL`, optional `BOOTSTRAP_ADMIN_PASSWORD` (otherwise prompted)

## Notes
The auth service validates credentials and issues JSON Web Tokens; downstream access control is enforced with shared guards from `@food-delivery/shared`. Its profile-creation call uses HMAC service authentication with a service identity, timestamp, nonce, and body-bound signature. A shared `INTERNAL_AUTH_SECRET` must be rotated through deployment configuration, not source code.
