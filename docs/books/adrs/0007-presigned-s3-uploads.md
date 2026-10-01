# ADR 0007 — Presigned S3 Uploads

**Status:** Accepted (reconstructed from commits `1b893ca`, `6925083`) · [ADRs](README.md) · Book: [17](../17-security-engineering.md) · Case study: [14](../case-studies/14-s3-presigned-uploads.md) · Lab: [SEC-05](../labs/security-labs.md#sec-05-presigned-upload-end-to-end)

## Context

- Users, restaurants and menu items have images.
- The services are small Node processes behind an HTTP proxy, and buffering uploads through them costs memory and widens the attack surface.

## Decision

Uploads go **directly to S3-compatible storage** in three steps, all implemented in `shared/src/storage/s3-storage.service.ts`:
1. **Presigned POST policy:** bounded size and content type, short expiry, key under `pending/<owner prefix>`.
2. The client uploads straight to storage.
3. A **confirm** step: the service checks the key prefix, verifies magic bytes, and copies the object to a content-hash key.

Dev and test use SeaweedFS.

## Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| multipart upload through the service | simple client; bytes through gateway + service; DoS surface |
| presigned **PUT** (first version) | no size limit in the signature; weaker content-type control |
| store images in PostgreSQL (`bytea`) | transactional; bloats the DB and backups; no CDN |
| third-party image service | resizing and CDN included; vendor, cost |

## Consequences

**Good**
- Services never stream file bytes.
- Storage enforces size.
- Unverified bytes are never served, and abandoned uploads expire (`pending/` lifecycle rule).

**Costs**
- Three client round trips.
- CORS must be configured for the storage endpoint and the gateway.
- No re-encoding, so metadata is kept.
- Production must provide real credentials and the lifecycle rule.

**Revisit when** images need resizing or variants (add a processing step on confirm or a CDN image service).
