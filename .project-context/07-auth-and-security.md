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
- `ADMIN`

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
- **Public registration picks the role on the server.** `RegisterDto.role` accepts only `SELF_SERVICE_ROLES` (`CUSTOMER`, `RESTAURANT_OWNER`, `DRIVER`; omitted or null → `CUSTOMER`). `AuthService.register` re-checks the same allow-list before touching the database (403), so `ADMIN` can never be self-assigned (#105, found in the 2026-10-01 review). There is no admin-provisioning endpoint: admins are created out of band. The only ADMIN principals in normal operation are service system tokens.
- Email verification (off by default: `EMAIL_VERIFICATION_REQUIRED=false`) and failed-login lockout (5 attempts → 15 minutes, generic "Invalid email or password") are implemented.
- Ownership is enforced per object in each service (orders, payments, deliveries, tracking, notifications). Drivers may only move themselves between OFFLINE and AVAILABLE; claim and release are system-token (ADMIN) operations (#33).

## Current auth backlog and planned hardening

The current auth implementation is intentionally minimal and is tracked as a managed backlog in the issue registry. The current documented gaps are:

- refresh-token lifecycle and rotation
- logout and token revocation
- password change and reset flows
- MFA / 2FA enhancement after the base security model is in place
- approval before a self-registered `DRIVER` or `RESTAURANT_OWNER` can operate (today these business roles are self-service)
- service identity: system tokens are signed with the shared `JWT_SECRET` and carry `role: ADMIN`, so any service holding the secret can act as any user and audit logs cannot tell a service from an admin

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
