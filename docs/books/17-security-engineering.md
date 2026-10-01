# Book 17 — Security Engineering

[Library index](README.md) · Previous: [Book 16](16-networking.md) · Next: [Book 18 — CI/CD & DevOps](18-cicd-and-devops.md)

**Level:** Intermediate → Senior · **Prerequisites:** [Book 03](03-http-apis-and-web.md), [Book 04 Ch. 11](04-database-fundamentals.md#chapter-11--database-security-and-least-privilege), [Book 11](11-nestjs-typescript-backend.md).

Security in Delivery Plus is taught here through real findings. Several authorization bugs were found and fixed in this codebase; others are known and tracked. Each is a case study you can reproduce locally.

**Labs:** [security-labs.md](labs/security-labs.md).

---

## Chapter 1 — Authentication: passwords, lockout, verification and tokens

### 1. Why this exists
Authentication answers "who are you?". Every later decision depends on it being right.

### 2. Core concept
- **Password hashing**: slow, salted, adaptive (bcrypt, scrypt, Argon2). Never reversible encryption, never fast hashes.
- **Brute-force defences**: rate limiting, account lockout, CAPTCHAs, MFA.
- **Enumeration resistance**: the same response whether the account exists or not.
- **Tokens**: short-lived access tokens; refresh tokens with rotation and revocation.

### 3. Mental model
Assume the credential database will leak one day. Hashing decides whether that's an inconvenience or a catastrophe.

### 4. Delivery Plus mapping — **CURRENT** (`services/auth-service/src/services/auth.service.ts`)
| Control | Implementation |
| --- | --- |
| Hashing | bcrypt, `SALT_ROUNDS = 10` |
| Lockout | `MAX_FAILED_LOGIN_ATTEMPTS` (default 5) → `lockedUntil` for `LOCKOUT_MINUTES` (default 15) |
| Rate limiting | 5 requests / 60 s on register, login, verify-email, resend (`auth.controller.ts`) |
| Enumeration | login always says "Invalid email or password"; resend says "If that account exists, a verification email has been sent" |
| Email verification | 32 random bytes, stored only as SHA-256, with expiry; enforcement controlled by `EMAIL_VERIFICATION_REQUIRED` (default **false**) |
| Tokens | HS256 JWT, 1 h, no refresh token (**PLANNED** #34); no password reset/change (**PLANNED** #35) |
| Self-chosen role at registration | **Fixed in PR #105 (was critical):** `RegisterDto.role` used to accept any `UserRole` including `ADMIN`, and `register` stored `dto.role ?? CUSTOMER`. Now only `SELF_SERVICE_ROLES` are accepted, checked in the DTO and again in the service (`services/auth-service/src/dto/register.dto.ts`, `auth.service.ts`). Before the fix, anyone could create an ADMIN account through the public `POST /api/auth/register` — [case study 21](case-studies/21-self-registered-admin.md) |

### 5. Example — the lockout counter makes online guessing expensive: 5 tries per 15 minutes per account ≈ 480 guesses per day, regardless of how many IPs the attacker uses.
### 6. Failure scenario — lockout as a DoS: an attacker who knows a customer's email can lock them out forever by failing 5 logins every 15 minutes. Mitigations: lock per (account, IP/device), progressive delays instead of hard locks, MFA.
### 7. Trade-offs — bcrypt cost 10 ≈ tens of ms per hash: higher cost = stronger against offline cracking, slower logins and more CPU (the login rate limit also protects the server's CPU).
### 8. Performance — bcrypt runs on libuv's thread pool (default 4 threads): a burst of logins queues behind 4 hashes at a time.
### 9. Security — this chapter.
### 10. Operations — monitor failed-login rates per account and per IP; alert on spikes (credential stuffing).

### 11. Lab
[SEC-04 Brute force versus lockout](labs/security-labs.md#sec-04-brute-force-versus-lockout).

### 12. Verification
After 5 wrong passwords the correct password is also rejected until the lock expires; `credentials."lockedUntil"` shows the time.

### 13. Interview questions
- *Beginner:* Why hash passwords instead of encrypting them?
- *Intermediate:* What is a salt?
- *Advanced:* How can account lockout itself become an attack?
- *Senior:* Design token lifetimes and refresh rotation for customer, driver and restaurant apps.

### 14. Senior discussion
Email verification exists but is off by default. Under what conditions would you turn it on, and what has to exist first (an email provider, which the repository doesn't have)?

---

## Chapter 2 — Authorization: RBAC, ownership and IDOR/BOLA

### 1. Why this exists
The most common serious API vulnerability is not broken crypto; it is **Broken Object Level Authorization** (BOLA, also called IDOR): "I changed the ID in the URL and got someone else's data."

### 2. Core concept
- **RBAC**: what a *role* may do (CUSTOMER, RESTAURANT_OWNER, DRIVER, ADMIN).
- **Ownership / object-level authorization**: whether *this* user may act on *this* object.
- Both are needed; roles alone are never enough.
- Prefer **404** over **403** when revealing existence is itself a leak.

### 3. Mental model
For every route, answer two questions: "which roles?" and "whose objects?". If you can't answer the second, it's a BOLA bug.

### 4. Delivery Plus mapping — real findings
| Finding | Before | After (CURRENT) | Case study |
| --- | --- | --- | --- |
| Delivery reads | any authenticated user could read any delivery | order's customer, assigned driver, owner of the order's restaurant (checked by order-service with the caller's token), admin | [02](case-studies/02-delivery-ownership-bug.md) |
| Delivery dispatch | any restaurant owner could create/assign/cancel deliveries for any order | admin, or the owner of *that order's* restaurant | [02](case-studies/02-delivery-ownership-bug.md) |
| Driver profiles | `GET /drivers/available`, `GET /drivers/:id` public (licence plates) | admin/system token, or the driver themself | [03](case-studies/03-public-driver-endpoint.md) |
| Driver location | `GET /tracking/driver/:userId` public | the driver themself or admin; customers go through delivery ownership | [03](case-studies/03-public-driver-endpoint.md) |
| Notifications | any user could mark any notification read | owner only, 404 otherwise | [04](case-studies/04-notification-ownership.md) |
| Refunds | a customer could refund their own completed payment, even after delivery | admin only | [Book 25](25-payment-systems.md) |
| **Still open** | restaurant `ownerId` returned in public restaurant payloads; `GET /restaurants/:id/ownership/:userId` is unauthenticated (an ownership oracle) | — | issue #59 |
| **Fixed (#33)** | a BUSY driver could set themselves AVAILABLE and take a second delivery; drivers may now only go online/offline (403 while BUSY) | `driver-transition-rules.ts` | issue #33 |
| **Fixed (PR #105)**; one part still open | public registration accepted `role: "ADMIN"`. Fixed with an allow-list plus a service re-check. **Still open:** DRIVER/RESTAURANT_OWNER are self-assigned without any approval | — | [case study 21](case-studies/21-self-registered-admin.md) |

### 5. Example — ownership delegated to the source of truth: delivery-service doesn't re-implement order access rules; it calls `GET /orders/:id` on order-service **with the caller's own token** (`OrderServiceClient.assertReadableBy` in `services/delivery-service/src/common/order-service.client.ts`). Whatever order-service decides (owner, restaurant owner, admin) is what delivery-service enforces.

### 6. Failure scenario — "authenticated" mistaken for "authorized": a route guarded only by `JwtAuthGuard` is open to *every* customer, driver and owner on the platform.
### 7. Trade-offs — delegating ownership checks costs an extra HTTP call; replicating ownership data locally (events) is faster but can go stale.
### 8. Performance — one extra call per protected read; cacheable per (user, resource) for short periods if needed.
### 9. Security — write negative tests for every role that must be refused (the delivery-service specs do).
### 10. Operations — log authorization denials with user ID and resource ID (not just "403") to detect probing.

### 11. Lab
[SEC-07 Reproduce a BOLA check](labs/security-labs.md#sec-07-reproduce-a-bola-check). And [SEC-08 Self-registered admin](labs/security-labs.md#sec-08-self-registered-admin) — the most severe finding in the codebase, fixed in PR #105: run it before and after the fix.

### 12. Verification
Customer B gets 403 for customer A's order and delivery, and 404 when marking A's notification read.

### 13. Interview questions
- *Beginner:* RBAC vs ownership checks?
- *Intermediate:* What is IDOR/BOLA?
- *Advanced:* Why forward the user's token instead of using a system token for ownership checks?
- *Senior:* How do you audit 60+ routes across 12 services for BOLA systematically?

### 14. Senior discussion
Should authorization be centralised (a policy engine like OPA, or the gateway) or stay in each service? What did this project's bugs suggest?

---

## Chapter 3 — Service identity, secrets and key rotation

### 1. Why this exists
Services call each other with elevated privileges; those credentials are the keys to the kingdom.

### 2. Core concept
- **Secrets**: credentials that grant access (JWT signing key, DB passwords, HMAC keys, S3 keys).
- **Secret management**: injected at runtime from a vault/secret manager, never committed, rotated regularly, scoped per consumer.
- **Rotation**: support two valid keys during a transition.

### 3. Mental model
The blast radius of a secret = everything that trusts it.

### 4. Delivery Plus mapping — **CURRENT**
| Secret | Used by | Blast radius |
| --- | --- | --- |
| `JWT_SECRET` (HS256) | every service verifies; auth-service, payment-, delivery-, tracking-service sign | anyone holding it can mint any user's token, including ADMIN — [case study 18](case-studies/18-system-token.md) |
| `INTERNAL_AUTH_SECRET` (HMAC) | auth-service signs, user-service verifies (`docs/adr/001-internal-service-authentication.md`) | can create user profiles |
| `POSTGRES_PASSWORD` (superuser) | all DB-backed services | all nine databases |
| S3 access keys | user-, restaurant-, menu-service | the media bucket |
- Local defaults live in `.env.example` and Compose files; the prod overlay requires real values (`${VAR:?…}`) and fails fast without them.
- **NOT IMPLEMENTED:** a secret manager, rotation procedures, per-service DB credentials, asymmetric JWT signing.

### 5. Example — system tokens: `services/delivery-service/src/common/system-token.service.ts` signs `{ sub: 'system:delivery-service', role: 'ADMIN' }` with `JWT_SECRET`, valid for minutes. Receiving services see an ADMIN.
### 6. Failure scenario — one service compromised (e.g. via a dependency) → `JWT_SECRET` read from its environment → attacker mints ADMIN tokens for all services and calls `POST /payments/:id/refund`.
### 7. Trade-offs
| Option | Effort | Gain |
| --- | --- | --- |
| Asymmetric signing (RS256/EdDSA): only auth-service holds the private key | medium | services can verify but not mint user tokens |
| Distinct service role + per-route permissions | medium | system tokens can't do human-admin actions |
| mTLS / workload identity (SPIFFE) | high | strong transport-level identity |

### 8. Performance — negligible.
### 9. Security — this chapter.
### 10. Operations — rotation runbook: add new key → services accept both → issuers switch → remove old key.

### 11. Lab
[SEC-03 Mint and inspect a system token](labs/security-labs.md#sec-03-mint-and-inspect-a-system-token).

### 12. Verification
A token you mint with the dev `JWT_SECRET` and `role: ADMIN` is accepted by driver-service's admin-only route.

### 13. Interview questions
- *Beginner:* Why must secrets not be committed?
- *Intermediate:* HS256 vs RS256 for multiple services?
- *Advanced:* How do you rotate a JWT signing key without logging everyone out?
- *Senior:* Design service identity for Delivery Plus on Kubernetes.

### 14. Senior discussion
Is a shared HMAC secret per service pair (like the auth → user call) better or worse than one shared JWT secret for all service calls?

---

## Chapter 4 — Input validation, injection, SSRF and file uploads

### 1. Why this exists
Every input is attacker-controlled until proven otherwise.

### 2. Core concept
- **SQL injection**: untrusted input changes query structure → use parameterised queries.
- **SSRF**: tricking a server into making requests to unintended destinations (internal services, cloud metadata).
- **XSS**: injecting script into pages other users load.
- **Mass assignment**: clients setting fields they shouldn't (role, price, status).
- **File upload risks**: oversized files, content-type spoofing, polyglots, path traversal in keys.

### 3. Mental model
Validate shape at the edge, authorize at the service, constrain at the database.

### 4. Delivery Plus mapping — **CURRENT**
- SQL: TypeORM parameters everywhere, including search (`ILIKE :search` in `services/restaurant-service/src/repositories/restaurants.repository.ts`).
- Mass assignment: global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted`; DTOs don't contain `price`, `role` or `status` where clients mustn't set them (cart prices come from menu-service).
- SSRF / path injection in internal calls: every service client calls `assertValidUuidV4(id)` before building a URL (`shared/src/utils/id.ts`) — an ID like `../../internal/users` is rejected.
- Uploads (`shared/src/storage/s3-storage.service.ts`): presigned POST with `content-length-range`, allowed types JPEG/PNG/WebP, 5-minute URLs, key prefix bound to the requester; confirm verifies size, signed metadata and **magic bytes** before copying to a content-addressed key.
- XSS: React escapes text by default; uploaded files are verified images, not served HTML.
- **Weakness:** `AllExceptionsFilter` returns raw messages of unexpected errors on 500 (Book 01 Ch. 5) — an information leak.

### 5. Example
```bash
curl -s -X POST localhost:3000/api/cart/items -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"menuItemId":"…","quantity":1,"price":0.01}'
# 400: property price should not exist
```
### 6. Failure scenario — trusting `Content-Type` from the upload: an SVG with embedded script labelled `image/png`, served from your domain → stored XSS. Magic-byte verification closes it.
### 7. Trade-offs — strict validation rejects some legitimate edge cases (e.g. non-ASCII idempotency keys are rejected by design).
### 8. Performance — confirm downloads the object to verify bytes; size limits keep that bounded.
### 9. Security — this chapter.
### 10. Operations — log validation failures by route; a spike indicates probing.

### 11. Lab
[SEC-05 Presigned upload end to end](labs/security-labs.md#sec-05-presigned-upload-end-to-end).

### 12. Verification
An HTML file renamed to `.png` is rejected at confirm; a confirm with another user's key prefix is rejected.

### 13. Interview questions
- *Beginner:* How do parameterised queries prevent SQL injection?
- *Intermediate:* What is mass assignment?
- *Advanced:* Why validate magic bytes after upload?
- *Senior:* Where could SSRF still exist in Delivery Plus (hint: any URL taken from input or config)?

### 14. Senior discussion
Image URLs are stored and served from object storage. Would you add a CDN with a separate domain for user content? What attacks does that mitigate?

---

## Chapter 5 — Abuse protection: rate limiting and brute force

### 1. Why this exists
Attackers automate. Without limits, every endpoint is a free resource.

### 2. Core concept — per-identity limits, per-route budgets, global limits at the edge, progressive penalties, CAPTCHAs for anonymous flows.
### 3. Mental model — limit by the most specific trustworthy identity: user ID > device > IP.

### 4. Delivery Plus mapping — **CURRENT**
- `RateLimitGuard` with Redis fixed windows; class-level limits now enforced ([case study 05](case-studies/05-rate-limit-mismatch.md)).
- Gaps: no gateway-level limit; anonymous routes keyed by IP (proxy-sensitive); the `INCR`/`EXPIRE` non-atomicity can create permanent keys (Book 06 Ch. 5); the guard fails closed when Redis is down.

### 5. Example — cart: the 31st request in a minute returns 429.
### 6. Failure scenario — the cart's `@RateLimit` on the controller class was silently ignored because the guard only read method metadata — an entire service believed protected wasn't.
### 7. Trade-offs — fail-closed rate limiting turns a Redis outage into a full outage of protected routes.
### 8. Performance — 1–2 Redis calls per request.
### 9. Security — rate limits must cover expensive endpoints (login: bcrypt; search: full scans).
### 10. Operations — expose rate-limit headers (`Retry-After`) so well-behaved clients back off (not implemented).

### 11. Lab
[RD-04 Fixed-window rate limiter](labs/redis-labs.md#rd-04-fixed-window-rate-limiter).

### 12. Verification — 429 at the documented threshold on the cart and on login.

### 13. Interview questions
- *Beginner:* Why rate-limit login?
- *Intermediate:* Why did a class-level decorator get ignored?
- *Advanced:* How do you rate-limit behind a load balancer correctly?
- *Senior:* Abuse strategy for a public restaurant-search API.

### 14. Senior discussion
Rate limiting in the gateway, in each service, or both? What about bots that rotate IPs and accounts?

---

## Chapter 6 — Browser-side security: CORS, CSRF, token storage, headers

### 1. Why this exists
The web build of the customer app runs in a browser, with the browser's threat model.

### 2. Core concept
- **CORS** controls which origins' scripts may read responses (not who may call the API).
- **CSRF** abuses ambient credentials (cookies) — not applicable to Bearer tokens sent explicitly.
- **Token storage**: `localStorage` is readable by any script on the origin (XSS → token theft); HttpOnly cookies aren't readable by scripts but reintroduce CSRF.
- **Security headers**: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, frame options.

### 3. Mental model
XSS is game over for any token the page can read; CSP reduces the chance of XSS.

### 4. Delivery Plus mapping — **CURRENT**
- CORS: allowed origins, methods and headers in `getCorsOptions` (`services/api-gateway/src/main.ts`); production requires `CORS_ORIGINS`.
- Token storage: `expo-secure-store` (Keychain/Keystore) on native; `localStorage` on web (`delivery-plus-customer-app/src/services/session.ts`).
- CSRF: tokens are sent as `Authorization: Bearer`, not cookies → classic CSRF doesn't apply.
- Security headers: **not set** by the gateway or services (no `helmet`).

### 5. Example — CORS with an untrusted origin: the browser blocks reading the response; `curl` from a server doesn't care.
### 6. Failure scenario — a compromised npm dependency in the web build reads `localStorage` and posts the JWT to an attacker; with a 1-hour token, the attacker has an hour of full account access.
### 7. Trade-offs — cookies (HttpOnly, SameSite) vs Bearer in storage: different attacks, different defences.
### 8. Performance — none.
### 9. Security — add CSP and HSTS at the edge when TLS exists; consider HttpOnly cookie sessions for the web client if XSS risk dominates.
### 10. Operations — CSP violation reports reveal attempted injections.

### 11. Lab — inspect the gateway's response headers (`curl -I localhost:3000/api/restaurants`) and list which security headers are missing.
### 12. Verification — your list includes CSP, HSTS (once TLS exists), `X-Content-Type-Options`, `Referrer-Policy`.

### 13. Interview questions
- *Beginner:* What is CORS for?
- *Intermediate:* Why doesn't CSRF apply to Bearer-token APIs?
- *Advanced:* `localStorage` vs HttpOnly cookies for SPAs?
- *Senior:* Web security baseline for the restaurant dashboard (a web app with privileged users).

### 14. Senior discussion
The restaurant dashboard (#100) will likely be web-only with powerful actions. Would you choose the same token storage as the customer web build?

---

## Chapter 7 — Infrastructure security, scanning and audit

### 1. Why this exists
Application security fails open if the infrastructure underneath trusts everyone.

### 2. Core concept — least privilege everywhere, network segmentation, authenticated infrastructure (DB, Redis, Kafka), dependency and image scanning, audit logs of privileged actions.

### 3. Mental model — defence in depth: each layer assumes the one above failed.

### 4. Delivery Plus mapping
| Control | Status |
| --- | --- |
| CodeQL, `npm audit` (block on critical), Trivy filesystem + secret scan | **CURRENT** — `.github/workflows/security.yml` |
| Trivy image scan per service, fail on CRITICAL | **CURRENT** — `.github/workflows/docker.yml` |
| Dependabot | **CURRENT** — `.github/dependabot.yml` |
| Prod overlay requires secrets, publishes no infrastructure ports | **CURRENT** — `docker-compose.prod.yml` |
| PostgreSQL per-service roles | **NOT IMPLEMENTED** (superuser everywhere) |
| Redis auth / ACL, Kafka ACLs/TLS | **NOT IMPLEMENTED** |
| Non-root containers, pinned `kafka-ui` | **NOT IMPLEMENTED** (#14) |
| Audit log for admin actions (refunds, status overrides) | **NOT IMPLEMENTED** |
| Security policy & reporting | `SECURITY.md` |

### 5. Example — a refund is the most sensitive action in the system; today it is authorized (admin only) but not audited: no record of *which* admin refunded *what* and *why*.
### 6. Failure scenario — any container on the Docker network can write Redis keys: forging `kafka:idempotency:…=processed` silently suppresses events; deleting `ratelimit:*` removes brute-force protection.
### 7. Trade-offs — each control adds configuration and secrets; prioritise by blast radius (DB roles and JWT signing first).
### 8. Performance — negligible.
### 9. Security — this chapter.
### 10. Operations — security findings need owners and deadlines like any bug.

### 11. Lab
[SEC-06 Least-privilege role for one service](labs/security-labs.md#sec-06-least-privilege-role-for-one-service).

### 12. Verification — a per-service role can't read `auth_service.credentials`.

### 13. Interview questions
- *Beginner:* What does a dependency scanner find?
- *Intermediate:* Why audit-log admin actions?
- *Advanced:* What can an attacker do with write access to this Redis?
- *Senior:* Rank the top five security investments for Delivery Plus before launch.

### 14. Senior discussion
Given limited time, would you invest first in per-service DB roles, asymmetric JWT signing, or an audit log? Defend the order using blast radius and likelihood.

---

[Library index](README.md) · Previous: [Book 16](16-networking.md) · Next: [Book 18 — CI/CD & DevOps](18-cicd-and-devops.md)
