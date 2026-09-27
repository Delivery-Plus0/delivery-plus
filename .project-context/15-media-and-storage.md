# Media and Storage

## Ownership and persistence

Image metadata remains in the owning service's database; image bytes live in a shared S3-compatible bucket. `user-service` owns `UserProfile.avatarUrl`, `restaurant-service` owns `Restaurant.coverImageUrl` and `Restaurant.logoUrl`, and `menu-service` owns the existing nullable `MenuItem.imageUrl`. No image bytes are proxied through NestJS or stored in PostgreSQL.

## Presigned upload flow

1. An authenticated caller requests a presigned PUT URL from the service that owns the resource.
2. The service checks resource ownership before requesting a URL. User avatars are scoped to the caller's own profile; restaurant images require restaurant ownership; menu item images check ownership through restaurant-service using the menu item's stored `restaurantId`.
3. The client PUTs directly to object storage using the exact returned `Content-Type` and `x-amz-meta-max-size-bytes` headers. URLs expire after five minutes.
4. The client calls the owning service's confirm endpoint with the returned `objectKey` (and `imageType` for restaurant images).
5. The service derives the expected key prefix from the authenticated identity and database resource. The shared storage service rejects a key outside that prefix before querying S3, then checks the stored MIME type, signed max-size metadata, and actual object byte length. Only a verified object gets a public/CDN URL persisted.

The allowed MIME types are `image/jpeg`, `image/png`, and `image/webp`. Avatar objects are limited to 5 MiB; restaurant and menu item objects are limited to 10 MiB. Since S3 presigned PUTs cannot enforce a maximum range in the URL policy, the service enforces the size at confirmation; an oversized object is never persisted as media and should be removed through operational cleanup if necessary.

## Key layout

- `users/{userId}/avatar/{uuid}.{jpg|png|webp}`
- `restaurants/{restaurantId}/cover/{uuid}.{jpg|png|webp}`
- `restaurants/{restaurantId}/logo/{uuid}.{jpg|png|webp}`
- `restaurants/{restaurantId}/menu-items/{menuItemId}/{uuid}.{jpg|png|webp}`

Keys are generated server-side. Confirm requests accept only the object key; clients cannot choose a bucket, prefix, file extension, or public URL.

## Security and URL configuration

- `S3StorageService` uses a server-side MIME allowlist, random UUID keys, a five-minute signature, signed content-type and size metadata, and `HeadObject` confirmation.
- The browser-facing presigned endpoint can differ from the endpoint used by service containers. In Compose, services use `AWS_S3_ENDPOINT=http://minio:9000` while signatures use `AWS_S3_PUBLIC_ENDPOINT=http://localhost:9000`.
- `AWS_PUBLIC_BASE_URL` may point to a CDN or public object base URL. Local MinIO setup grants anonymous download access only; object writes remain authenticated/presigned and bucket listing is not enabled.
- Production does not use local fallback credentials or MinIO. Configure an AWS role or dedicated S3 credentials with least privilege, a private upload bucket, public/CDN read policy as required, and restrictive bucket CORS origins.
- Do not log presigned URLs or commit production credentials. Local dummy credentials belong only in `.env.example` and local Compose defaults.

## Local infrastructure

`docker-compose.dev.yml` and `docker-compose.test.yml` add MinIO and a one-shot bucket initializer. The initializer creates `delivery-plus-media`, applies read-only anonymous download policy, and configures CORS for browser GET/HEAD/PUT requests. MinIO data persists in a named volume. Production Compose intentionally does not start MinIO.

## Source of truth

- Shared implementation: [shared/src/storage/s3-storage.service.ts](../shared/src/storage/s3-storage.service.ts)
- Service endpoints: `services/{user,restaurant,menu}-service/src/controllers/`
- Database schema: [04-database-design.md](04-database-design.md)
- Local infra and env: [08-docker-and-infra.md](08-docker-and-infra.md), [12-environment-and-setup.md](12-environment-and-setup.md)