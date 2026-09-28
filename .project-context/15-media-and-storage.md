# Media and Storage

## Ownership and persistence

Image metadata remains in the owning service's database; image bytes live in a shared S3-compatible bucket. `user-service` owns `UserProfile.avatarUrl`, `restaurant-service` owns `Restaurant.coverImageUrl` and `Restaurant.logoUrl`, and `menu-service` owns the existing nullable `MenuItem.imageUrl`. No image bytes are proxied through NestJS or stored in PostgreSQL.

## Presigned upload flow

1. An authenticated caller requests a presigned POST policy from the service that owns the resource.
2. The service checks resource ownership before requesting a URL. User avatars are scoped to the caller's own profile; restaurant images require restaurant ownership; menu item images check ownership through restaurant-service using the menu item's stored `restaurantId`.
3. The client sends a multipart POST directly to object storage using the returned `uploadUrl` and every field in `fields`. The policy restricts the exact content type and metadata and enforces a 1-byte-to-maximum-size content-length range. Policies expire after five minutes.
4. The client calls the owning service's confirm endpoint with the returned `objectKey` (and `imageType` for restaurant images).
5. The service derives the expected key prefix from the authenticated identity and database resource. The shared storage service rejects a key outside that prefix, checks the maximum size and issued metadata, reads the object bytes to validate the image format, and copies the verified object to a content-addressed permanent key. The client can only upload under `pending/`, so a still-valid policy cannot replace a confirmed image.

The allowed MIME types are `image/jpeg`, `image/png`, and `image/webp`. Avatar objects are limited to 5 MiB; restaurant and menu item objects are limited to 10 MiB. A lifecycle rule expires all objects under `pending/` after one day, including uploads that are never confirmed.

## Key layout

- `pending/users/{userId}/avatar/{uuid}.{jpg|png|webp}` (temporary upload)
- `pending/restaurants/{restaurantId}/{cover|logo}/{uuid}.{jpg|png|webp}` (temporary upload)
- `pending/restaurants/{restaurantId}/menu-items/{menuItemId}/{uuid}.{jpg|png|webp}` (temporary upload)
- `users/{userId}/avatar/{sha256}.{jpg|png|webp}` (verified object)
- `restaurants/{restaurantId}/{cover|logo}/{sha256}.{jpg|png|webp}` (verified object)
- `restaurants/{restaurantId}/menu-items/{menuItemId}/{sha256}.{jpg|png|webp}` (verified object)

Keys are generated server-side. Confirm requests accept only the object key; clients cannot choose a bucket, prefix, file extension, or public URL.

**Breaking change:** menu-service's create/update menu item DTOs no longer accept a caller-supplied `imageUrl`. Clients must use the presigned upload and confirmation endpoints (`POST /menu-items/:id/image-upload-url` then `POST /menu-items/:id/image-confirm`) to set an item's image.

## Security and URL configuration

- `S3StorageService` uses a server-side MIME allowlist, random staging keys, a five-minute POST policy with content-length-range and exact content-type constraints, and byte-level confirmation. Confirmed bytes are copied to a content-addressed permanent key to prevent an outstanding upload policy from replacing them.
- The browser-facing presigned endpoint can differ from the endpoint used by service containers. In Compose, services use `AWS_S3_ENDPOINT=http://media-storage:9000` while signatures use `AWS_S3_PUBLIC_ENDPOINT=http://localhost:9000`.
- `AWS_PUBLIC_BASE_URL` may point to a CDN or public object base URL. The local dev/test bucket policy grants anonymous `GetObject` on every key **except** the `pending/` prefix (unconfirmed uploads stay private until verified); object writes remain authenticated/presigned and bucket listing is not enabled.
- Production does not use local fallback credentials or the local `media-storage` container. Configure an AWS role or dedicated S3 credentials with least privilege, a private upload bucket, public/CDN read policy as required, restrictive bucket CORS origins, and a lifecycle rule expiring objects with the `pending/` prefix after one day.
- Do not log presigned URLs or commit production credentials. Local dummy credentials belong only in `.env.example` and local Compose defaults.

### Known limitation: orphaned verified objects on DB-write failure

If the S3 copy to the content-addressed verified key succeeds but the owning service's database write then fails (e.g. a transient Postgres error), the verified object is left in the bucket with no database row referencing it. This is not a data-corruption or security issue — a retried confirm call recomputes the same content hash and the same final key, so it is naturally idempotent and self-heals on retry — but if the caller never retries, the object is not cleaned up automatically (it lives outside the `pending/` prefix, so the lifecycle rule does not expire it). This is accepted as follow-up technical debt rather than a PR blocker: fixing it properly would need an outbox/reconciliation job disproportionate to how rarely a confirm call fails after a successful upload.

## Local infrastructure

`docker-compose.dev.yml` and `docker-compose.test.yml` run a `media-storage` service (SeaweedFS's S3 gateway, `chrislusf/seaweedfs:4.47`) and a one-shot `media-storage-init` bucket initializer, instead of MinIO.

**Why not MinIO:** MinIO Inc. deleted its Docker Hub images on 2026-09-11 and quay.io gated anonymous pulls behind a required license/account on 2026-09-24. Both were confirmed unreachable anonymously (`401`/`pull access denied`) as of this change, from a plain `docker pull`, with no login configured — this is not a local misconfiguration, it is upstream MinIO distribution being discontinued for the free/community edition. There is no way to run genuine MinIO in CI or a fresh clone without a paid license going forward.

**Why SeaweedFS:** it is Apache 2.0 licensed, freely and anonymously pullable, and its S3 gateway was verified (before adopting it) to correctly enforce every S3 semantic `S3StorageService` and this feature's threat model depend on: presigned POST `content-length-range` enforcement (oversized uploads rejected before they reach storage), exact `Content-Type` condition enforcement (a mismatched declared type is rejected), conditional `GetObject`/`CopyObject` via `IfMatch`/`CopySourceIfMatch`, `MetadataDirective: REPLACE` on copy, bucket policies (including `NotResource` to exclude a prefix from public read), and automatic CORS preflight handling. No application code changes were required — the shared storage service only talks to a generic S3-compatible endpoint.

The initializer creates the configured bucket, applies a bucket policy granting anonymous `GetObject` on every key except `pending/*`, and applies a lifecycle rule expiring `pending/` objects after one day. `media-storage` data persists in a named volume (`media_storage_data` in dev, `media_storage_test_data` in test). Production Compose intentionally does not start `media-storage`.

## Source of truth

- Shared implementation: [shared/src/storage/s3-storage.service.ts](../shared/src/storage/s3-storage.service.ts)
- Service endpoints: `services/{user,restaurant,menu}-service/src/controllers/`
- Database schema: [04-database-design.md](04-database-design.md)
- Local infra and env: [08-docker-and-infra.md](08-docker-and-infra.md), [12-environment-and-setup.md](12-environment-and-setup.md)