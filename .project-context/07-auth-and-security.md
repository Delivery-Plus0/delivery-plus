# Auth and Security

## Authentication model

The repository is designed around JWT-based authentication with distinct service-level authorization checks.

The canonical identity is created in the auth service:

- [services/auth-service/src/entities/credential.entity.ts](../services/auth-service/src/entities/credential.entity.ts)

That entity defines:

- `email`
- `passwordHash`
- `role`
- the generated `id` that acts as the shared user identifier

## Shared roles

The available roles live in the shared package:

- [shared/src/types/enums.ts](../shared/src/types/enums.ts)

The defined roles are:

- `CUSTOMER`
- `RESTAURANT_OWNER`
- `DRIVER`
- `ADMIN`: staff; what each person may do is in the token's `perms` (#202)
- `SYSTEM`: a service calling another service (#202); never a person, never a credential

These values are used as role enums in the credentials table and by guard logic across service boundaries.

## Identity and profile split

The platform separates identity from profile:

- `auth-service` owns authentication credentials
- `user-service` owns profile information such as name, email, phone, and address

This pattern appears in:

- [services/auth-service/src/entities/credential.entity.ts](../services/auth-service/src/entities/credential.entity.ts)
- [services/user-service/src/entities/user-profile.entity.ts](../services/user-service/src/entities/user-profile.entity.ts)

The design is intentionally consistent:

- same logical user
- same UUID as canonical `userId`
- different tables for different concerns

## Authorization pattern

The project uses shared JWT and access guard patterns instead of a monolithic auth layer. In practical terms:

- auth-service issues tokens
- downstream services validate the token and role claims
- role-based access checks constrain domain operations such as restaurant ownership, driver actions, and admin-only actions

This is a typical microservice approach: authentication at the edge, enforcement near the domain logic.

## Service ownership boundaries

Several service entities attach ownership to user identifiers:

- `restaurant-service` → `ownerId`
- `driver-service` → `userId`
- `notification-service` → `userId`
- `order-service` → `customerId`

This means the platform often relies on consistent user identifiers while still keeping business ownership state local to the service that owns the domain data.

## Implemented behavior

- Registration, login, and `GET /auth/me` are implemented in `auth-service`.
- JWT validation and role guards are shared by the domain services.
- Roles are `CUSTOMER`, `RESTAURANT_OWNER`, `DRIVER`, and `ADMIN`.
- **Public registration picks the role on the server.** `RegisterDto.role` accepts only `SELF_SERVICE_ROLES` (`CUSTOMER`, `RESTAURANT_OWNER`, `DRIVER`; omitted or null → `CUSTOMER`). `AuthService.register` re-checks the same allow-list before touching the database (403), so `ADMIN` can never be self-assigned (#105, found in the 2026-10-01 review). There is no admin-provisioning endpoint: the first admin is created out of band with the bootstrap CLI (#202), and services are `SYSTEM`, never `ADMIN`.
- Email verification (off by default: `EMAIL_VERIFICATION_REQUIRED=false`) and failed-login lockout (5 attempts → 15 minutes, generic "Invalid email or password") are implemented. While verification is required, register returns `{ userId, verificationRequired: true }` and no tokens (#34). The code is a 6-digit number emailed through the `EmailSender` port (#203): HMAC-stored, 10 minutes, single use, 5 attempts; resend limits count unknown addresses too, so they reveal nothing.
- **Sessions (#34).** Login (and register, when verification is off) returns a 15-minute access JWT and an opaque refresh token `<sessionId>.<secret>`.
  - Sessions live in auth-service Postgres (`auth_sessions`); only `sha256(secret)` is stored and compared in constant time.
  - `POST /auth/refresh` rotates the token in a compare-and-set UPDATE and re-reads the role. Reusing a rotated token revokes the whole session (theft detection). Every failure is `401 InvalidRefreshToken`.
  - `POST /auth/logout` ends one session; `POST /auth/logout-all` ends all of the user's sessions. Access tokens are not revoked: they expire within 15 minutes.
  - Access tokens carry `sid` (the session id), so a password change can keep only the current session (#35).
  - `POST /internal/auth/users/:id/revoke-sessions` (HMAC, callers in `AUTH_INTERNAL_ALLOWED_SERVICES`) ends sessions for password change/reset, suspension and staff actions.
  - A periodic job deletes sessions that ended more than `SESSION_RETENTION_DAYS` ago.
  - Details and the client contract: [docs/services/auth-service.md](../docs/services/auth-service.md#sessions-34).
- **SYSTEM principal (#202, F5).**
  - payment-, delivery- and tracking-service mint `role: SYSTEM` tokens signed with `SYSTEM_JWT_SECRET`, a separate secret from `JWT_SECRET`, valid for 2 minutes.
  - The shared `JwtAuthGuard` accepts a SYSTEM token only when it's signed with that secret and the request didn't come through the gateway. A user-secret token claiming SYSTEM is refused.
  - The gateway refuses any bearer token claiming SYSTEM. It also sets `x-delivery-plus-gateway` on every proxied request, after removing any client copy, so services can tell outside requests from internal ones.
  - Service-only routes (`GET /drivers/available`, `PATCH /drivers/:id/status`, `GET /orders/:id/fee-split`) accept only SYSTEM. Routes that both services and staff use accept both.
  - `SYSTEM_JWT_SECRET` is required in production: missing, the local default, shorter than 32 characters or equal to `JWT_SECRET` all stop the service at startup.
- **Account status and staff permissions (#202).** Accounts can be suspended: login and refresh then answer `403 AccountSuspended`, and the account's sessions are revoked. Staff tokens carry `perms`, read from `staff_permissions`. The first super admin comes from the bootstrap CLI ([runbook](../docs/runbooks/bootstrap-admin.md)).
- Ownership is enforced per object in each service (orders, payments, deliveries, tracking, notifications). Drivers may only move themselves between OFFLINE and AVAILABLE; claim and release are system-token (ADMIN) operations (#33).
- **Driver locations are untrusted claims (#60).**
  - A report is accepted only while the driver has an active delivery, resolved from their own token, and is stored bound to it. Reads only use positions bound to the delivery being read.
  - The client's `recordedAt` can only reject a report: future, too old, or replayed/out of order. Freshness is server time.
  - Derived values (tracking state, ETA, any future geofence) are display-only and never drive a delivery transition; client-sent ETA/geofence fields are rejected.
  - Details: [docs/services/tracking-service.md](../docs/services/tracking-service.md#trust-boundaries-60).

## Current auth backlog and planned hardening

The current auth implementation is intentionally minimal and is tracked as a managed backlog in the issue registry. The current documented gaps are:

- password change and reset flows (#35; session revocation is ready from #34)
- MFA / 2FA enhancement after the base security model is in place
- approval before a self-registered `DRIVER` or `RESTAURANT_OWNER` can operate (today these business roles are self-service)
- staff management (invitations, granting permissions, #216) and the admin console's actions (#215); the audit log (#213)

These gaps are tracked in GitHub and local issue metadata, especially:

- [../issues/024-auth-refresh-token-lifecycle.md](../issues/024-auth-refresh-token-lifecycle.md)
- [../issues/025-auth-password-change-and-recovery.md](../issues/025-auth-password-change-and-recovery.md)
- [../issues/026-auth-account-verification-and-lockout.md](../issues/026-auth-account-verification-and-lockout.md)

## Security assumptions and caveats

This project is structured for a backend learning/demo environment, not a production-grade identity platform. The current design assumptions include:

- JWT secret values are configured via environment variables
- local development uses a default secret in compose files
- services trust the authenticated identity provided through the token and associated guards
- cross-service trust is relatively lightweight and assumes the internal network is controlled
- `POST /internal/users` requires the HMAC internal service-auth contract and a one-time Redis nonce
- `GET /restaurants/:id/ownership/:userId` uses the same HMAC contract before asserting ownership for trusted internal callers such as menu-service and order-service
- `GET /users/:id` requires a JWT and allows only the owning user or an admin
- user-service rejects auth/profile mismatches when the JWT subject or email does not match the stored profile mapping

The accepted design and current implementation are documented in [ADR 001](../docs/adr/001-internal-service-authentication.md): HMAC-signed internal requests with an explicit service identity, timestamp, nonce, and body-bound signature. `auth-service` signs profile creation for `user-service`; `menu-service` and `order-service` sign ownership checks for `restaurant-service`. The receiving guards use Redis nonce replay protection, and production requires `INTERNAL_AUTH_SECRET`. Profile ownership and credential mapping are enforced in user-service.

The repo is therefore secure enough for a local development stack, but not designed as a finished production auth architecture out of the box.

## Source of truth

For role definitions and state enums:

- [shared/src/types/enums.ts](../shared/src/types/enums.ts)

For identity storage:

- [services/auth-service/src/entities/credential.entity.ts](../services/auth-service/src/entities/credential.entity.ts)
- [services/user-service/src/entities/user-profile.entity.ts](../services/user-service/src/entities/user-profile.entity.ts)

For gateway and service wiring:

- [services/api-gateway/src/main.ts](../services/api-gateway/src/main.ts)
- [docker-compose.yml](../docker-compose.yml)
