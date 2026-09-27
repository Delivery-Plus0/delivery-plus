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
- `POST /users/me/avatar/image-upload-url` – create a short-lived presigned avatar PUT URL
- `POST /users/me/avatar/confirm` – verify the uploaded object and save its public URL

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
- `PORT` (default: `3002`)
- `NODE_ENV` (default: `development`)
- `AWS_REGION`, `AWS_S3_BUCKET`, and `AWS_PUBLIC_BASE_URL`; S3 endpoint and credentials are configurable for local MinIO or a cloud provider

## Notes
The service acts as the canonical user-data layer for profile details. `POST /internal/users` requires the HMAC internal-auth contract in [ADR 001](../adr/001-internal-service-authentication.md) and records the verified caller in `createdByService`. Redis stores short-lived nonces with `SET NX EX` so a signed request cannot be replayed within the acceptance window. Profile rows store an explicit `authCredentialId` that must equal the profile `id` (the auth-service credential UUID). `GET /users/:id` is limited to the owning user or an admin. `GET/PATCH /users/me` and `GET /users/me/orders` require the JWT subject and email to match the stored profile.

Avatar uploads use a five-minute presigned PUT URL and allow JPEG, PNG, or WebP up to 5 MiB. Confirmation rechecks the authenticated profile, validates the object key under `users/{userId}/avatar/`, verifies S3 metadata and actual size, then persists `avatarUrl`. The field is nullable and was added with a forward TypeORM migration.
