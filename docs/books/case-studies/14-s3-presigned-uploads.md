# Case Study 14 — S3 Presigned Uploads

**Status: CURRENT (commits `1b893ca`, `6925083`, `43bfc4a`)** · [Case studies](README.md) · Books: [17](../17-security-engineering.md), [03](../03-http-apis-and-web.md) · ADR: [0007](../adrs/0007-presigned-s3-uploads.md) · Lab: [SEC-05](../labs/security-labs.md#sec-05-presigned-upload-end-to-end)

## The problem

Avatars, restaurant images and menu-item images must be stored somewhere. Streaming file bytes through the gateway and a NestJS service wastes memory and bandwidth. It also turns every service into a file-upload attack surface.

## The flow (CURRENT)

```text
1. client → service:  POST .../image-upload-url {contentType}
   service → client:  {uploadUrl, fields (policy + signature), objectKey}   ← pending/<caller prefix><uuid>.<ext>
2. client → storage:  multipart POST uploadUrl with fields + file           ← bytes never touch our services
3. client → service:  POST .../confirm {objectKey}
   service: checks key prefix belongs to caller → reads bytes → checks magic bytes are an allowed image
            → copies to <caller prefix><content hash>.<ext> → saves the public URL on the entity
```
- **Code:** `shared/src/storage/s3-storage.service.ts`, used by user-service (avatar), restaurant-service and menu-service.
- **Storage:** SeaweedFS (S3-compatible) in dev and test, port 9000. It replaced MinIO images that could no longer be pulled.

## The first version and why it changed

- **The first version used presigned PUT URLs.** A PUT URL fixes the key, but not the **size**, and only weakly the content type.
- **Presigned POST policies** carry conditions: a `content-length-range` and a content type. Storage itself rejects oversized uploads.
- Pending uploads **expire**: the dev Compose file installs a bucket lifecycle rule that deletes `pending/` objects after one day (`docker-compose.dev.yml`). Production needs the same rule on its real bucket.

## Defences, and what each one stops

| Defence | Stops |
| --- | --- |
| key prefix bound to the caller, checked on confirm ("outside the authorized resource prefix") | attaching someone else's object to your profile |
| policy size limit | 2 GB "avatars" |
| **magic-byte check on confirm** | HTML/JS uploaded as `image/jpeg` (stored XSS through your domain) |
| copy to a content-hash key after verification | serving unverified bytes; identical uploads dedupe |
| temp-object expiry | storage leak from abandoned uploads |
| production CORS required (`CORS_ORIGINS`, gateway fails closed in production) | arbitrary origins calling the API from a browser |

## Tests

- `shared/src/storage/s3-storage.service.spec.ts`: policy conditions, prefix checks, magic bytes, copy.
- Live: [SEC-05](../labs/security-labs.md#sec-05-presigned-upload-end-to-end) runs a real JPEG, HTML disguised as a JPEG, and a tampered key.

## Trade-offs

- Three round trips instead of one, and the client must handle a "confirm" failure.
- The service reads the bytes back on confirm, which costs a little bandwidth to gain trust.

## What can still go wrong

- Images are served from storage. If the bucket or CDN serves user content from the same origin as the app, a missed check is XSS. Serve user content from a separate domain.
- No image re-encoding, so EXIF metadata (GPS location in a photo) is kept.
- No malware scanning, which matters if non-image types are ever allowed.
- Outside production, unset `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` fall back to the well-known `minioadmin` development credentials. In production the service uses the AWS SDK's default credential chain instead. Make sure no shared or staging environment runs with `NODE_ENV` unset against real storage.

## What a senior engineer would ask

1. Why is the content type in the policy not enough on its own?
2. Where do the served images come from in production, and with which `Content-Type` and `Content-Disposition` headers?
3. Should confirm strip metadata by re-encoding? Where would that run?
