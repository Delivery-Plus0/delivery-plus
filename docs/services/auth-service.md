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
- `POST /auth/verify-email`, `POST /auth/resend-verification` – email verification.
- `GET /auth/me` – return the current user payload from the bearer token.

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

## Dependencies
- Calls `user-service` internally for user profile creation via `src/common/user-service.client.ts`, signing the request with the internal HMAC contract
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

## Notes
The auth service validates credentials and issues JSON Web Tokens; downstream access control is enforced with shared guards from `@food-delivery/shared`. Its profile-creation call uses HMAC service authentication with a service identity, timestamp, nonce, and body-bound signature. A shared `INTERNAL_AUTH_SECRET` must be rotated through deployment configuration, not source code.
