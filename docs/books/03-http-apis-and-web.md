# Book 03 — HTTP, APIs & Web Fundamentals

[Library index](README.md) · Previous: [Book 02](02-data-structures-and-algorithms.md) · Next: [Book 04 — Database Fundamentals](04-database-fundamentals.md)

**Level:** Junior → Intermediate · **Prerequisites:** Book 01; you have used `curl` or Postman.

Every interaction between the customer app and Delivery Plus — and between the services themselves — is HTTP. This book takes HTTP apart and puts it back together using the real gateway and real endpoints.

**Path through the system you will keep seeing:**

```text
Customer app (Expo)                    delivery-plus-customer-app/src/services/api.ts
   │  HTTPS (TLS terminated in front of the gateway in production; plain HTTP locally)
   ▼
API Gateway :3000                      services/api-gateway/src/main.ts  (CORS, internal-route block, proxy)
   │  HTTP, Docker network
   ▼
order-service :3006                    controller → guard → pipe → service → repository
   │  HTTP with a system JWT
   ▼
cart-service :3005 / restaurant-service :3003
```

---

## Chapter 1 — Requests, responses, methods, status codes and headers

### 1. Why this exists
Without a shared protocol, every client/server pair would invent its own. HTTP gives you verbs, addressing, metadata and error signalling that every proxy, cache, browser and library understands.

### 2. Core concept
A request = **method** + **target** (path + query) + **headers** + optional **body**. A response = **status code** + headers + optional body.

| Method | Meaning | Safe | Idempotent |
| --- | --- | --- | --- |
| GET | read | yes | yes |
| POST | create / perform an action | no | **no** (unless you add an idempotency key) |
| PUT | replace | no | yes |
| PATCH | partial update | no | not necessarily |
| DELETE | remove | no | yes |

Status classes: 2xx success, 3xx redirect, 4xx *caller's* problem, 5xx *server's* problem. The ones you'll see here: 200, 201, 204, 400, 401, 403, 404, 409, 429, 500, 502/504 (from proxies).

### 3. Mental model
Status codes are for *machines*: they decide whether to retry, re-authenticate or show an error. The body's `message` is for *humans*.

### 4. Delivery Plus mapping — **CURRENT**
- Gateway route table: the `PROXIES` map in `services/api-gateway/src/main.ts` (`/api/auth` → auth-service:3001 … `/api/notifications` → notification-service:3011), rewritten by `rewriteProxyPath`.
- Error envelope: `{ statusCode, error, message, timestamp, path, correlationId }` from `shared/src/nest/filters/http-exception.filter.ts`.
- `409` has two meanings here: `ConflictError` (e.g. "a delivery already exists for order …") and `InvalidStateTransitionError` (e.g. "Cannot transition Order from DELIVERED to PREPARING") — both in `shared/src/errors/app-error.ts`.
- Headers that matter: `Authorization: Bearer <jwt>`, `Idempotency-Key`, `X-Correlation-Id` (all three are allowed by the gateway's CORS config in `getCorsOptions`).

### 5. Example
```bash
curl -i http://localhost:3000/api/restaurants?page=1&limit=5
# HTTP/1.1 200 OK
# content-type: application/json; charset=utf-8
# x-correlation-id: 6f0c…      ← set by CorrelationIdMiddleware in restaurant-service
```

### 6. Failure scenario
Returning `200 { "success": false }` for errors. Retries, monitoring, alerting and client error handling all key on status codes; hiding failures in the body blinds all of them.

### 7. Trade-offs
Fine-grained codes (422 vs 400, 409 vs 412) help clients but every client must handle them. Delivery Plus keeps a small, consistent set.

### 8. Performance
Headers are sent with every request; large cookies or tokens add bytes to every call. A JWT is ~300–800 bytes.

### 9. Security
- Never put secrets in query strings — they end up in logs and browser history.
- 404 vs 403 leaks existence; Delivery Plus returns 404 for another user's notification on purpose.

### 10. Operations
In production, a spike in 5xx is an incident; a spike in 4xx is usually a client release bug or an attack. Alert on them separately.

### 11. Lab
Trigger each of 400, 401, 403, 404, 409 and 429 against the local gateway. Recipes: [SEC-01 Status code tour](labs/security-labs.md#sec-01-status-code-tour).

### 12. Verification
You have six `curl -i` outputs and can say, for each, whether a client should retry.

### 13. Interview questions
- *Beginner:* What does 201 mean, and when do you return 204?
- *Intermediate:* Which methods are idempotent and why does it matter for retries?
- *Advanced:* When is 409 the right answer and when is 422?
- *Senior:* How would you design error codes shared by 12 services and 3 client apps?

### 14. Senior discussion
Should the gateway normalise all upstream errors into one envelope, or pass them through untouched? What happens when an upstream crashes mid-response?

---

## Chapter 2 — Authentication over HTTP: JWT, sessions and cookies

### 1. Why this exists
HTTP is stateless: each request must prove who sent it.

### 2. Core concept
- **Server session**: server stores session data; the client holds an opaque ID (usually a cookie). Easy revocation, needs shared session storage.
- **JWT** (JSON Web Token): a signed claim set (`header.payload.signature`). Any service with the key can verify it without a lookup. Hard to revoke before expiry.
- **Cookies** vs **Authorization header**: cookies are sent automatically by browsers (hence CSRF risk); headers are sent explicitly by code.

### 3. Mental model
A JWT is a signed boarding pass: anyone can read it (base64), only the airline can issue it, and gates check the signature instead of calling the airline.

### 4. Delivery Plus mapping — **CURRENT**
- Issued by auth-service on login/register (`services/auth-service/src/services/auth.service.ts`), signed with `JWT_SECRET` (HS256), expiry `JWT_EXPIRES_IN` default **1h** (`services/auth-service/src/config/app-config.ts`). Claims: `sub` (user ID), `email`, `role` (`shared/src/nest/auth/jwt-payload.interface.ts`).
- Verified **in each service**, not in the gateway, by `JwtAuthGuard` (`shared/src/nest/auth/jwt-auth.guard.ts`).
- Customer app stores the token in the device keychain via `expo-secure-store` on native and in `localStorage` on web (`delivery-plus-customer-app/src/services/session.ts`) and sends it as a Bearer header.
- **PLANNED/FUTURE:** refresh tokens and rotation (issue #34). Today, after 1 hour the user signs in again.

### 5. Example
```bash
TOKEN=$(curl -s localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"customer@example.com","password":"password123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null; echo   # read the payload (not secret!)
```

### 6. Failure scenario
A stolen JWT is valid until it expires — there is no server-side revocation list. With a 1-hour expiry the window is bounded; with a 30-day token and no refresh rotation it would be a serious incident.

### 7. Trade-offs
| | Session | JWT |
| --- | --- | --- |
| Revocation | instant | at expiry (or a denylist, which reintroduces a lookup) |
| Cross-service | needs shared store | stateless verify |
| Size | tiny ID | hundreds of bytes |

### 8. Performance
HS256 verification is microseconds. Every service verifying independently costs nothing compared with an auth lookup per request.

### 9. Security
- `localStorage` is readable by any script on the page — an XSS bug becomes token theft. Native keychain storage is much safer. See [Book 17](17-security-engineering.md).
- A shared HS256 secret means *any* service holding it can mint tokens — including ADMIN system tokens ([case study 18](case-studies/18-system-token.md)).

### 10. Operations
Rotating `JWT_SECRET` logs everyone out and must be coordinated across all services at once (they all verify with the same secret).

### 11. Lab
[SEC-02 Inspect and tamper with a JWT](labs/security-labs.md#sec-02-inspect-and-tamper-with-a-jwt).

### 12. Verification
A token with a modified payload is rejected with 401; you can explain why base64-decoding the payload is not a vulnerability.

### 13. Interview questions
- *Beginner:* What are the three parts of a JWT?
- *Intermediate:* Why can't you "log out" a JWT?
- *Advanced:* HS256 vs RS256 for a microservice platform?
- *Senior:* Design token lifetimes and refresh for a mobile driver app that must stay signed in for a 10-hour shift.

### 14. Senior discussion
Should the gateway validate JWTs (defence in depth, one place) or should only services (as today, issue #37)? What does each mean when a service is accidentally exposed directly?

---

## Chapter 3 — Caching, ETags and conditional requests

### 1. Why this exists
The fastest request is one you don't make; the second fastest is one that returns "nothing changed".

### 2. Core concept
- `Cache-Control: max-age=60` — clients/proxies may reuse the response for 60 s.
- `ETag: "abc"` + `If-None-Match: "abc"` → `304 Not Modified` with no body.
- `Vary` — which request headers change the response (important for per-user data).

### 3. Mental model
HTTP caching is free infrastructure that already exists in browsers and CDNs — but only for responses you mark cacheable.

### 4. Delivery Plus mapping
- **NOT USED:** the services send no `Cache-Control` or `ETag` headers; every request reaches the service.
- **CURRENT (server side):** Redis cache-aside for restaurants and menus ([Book 06](06-redis.md)).
- **CURRENT (client side):** the customer app's stale-while-revalidate cache (`delivery-plus-customer-app/src/state/resource-cache.ts`, 10 s stale time).

### 5. Example
The restaurant list is public and identical for everyone. `Cache-Control: public, max-age=30` would let a CDN absorb most traffic.

### 6. Failure scenario
Marking a per-user response (`GET /api/orders`) as `public` lets a shared cache serve one customer's orders to another.

### 7. Trade-offs
HTTP caching is great for public, read-heavy data and dangerous for personalised data. Redis caching works for both but costs a request to the service.

### 8. Performance — a CDN hit is 10–50 ms from the user; a full trip to the service and DB can be 100+ ms on mobile.
### 9. Security — always `Cache-Control: private, no-store` on authenticated responses if you introduce caching.
### 10. Operations — caches complicate debugging ("I deployed but users see old data").

### 11. Lab
Add an ETag mentally: for `GET /api/menus/restaurants/:id/menu`, what would you hash, and when would it change? Write the answer, then check which writes call `cache.del('menu:…')` in `services/menu-service/src/services/menu.service.ts`.

### 12. Verification
Your ETag inputs change exactly when the menu cache is invalidated.

### 13. Interview questions
- *Beginner:* What is `max-age`?
- *Intermediate:* How do ETags save bandwidth?
- *Advanced:* What does `Vary: Authorization` do?
- *Senior:* Where would you put caching for a menu that changes a few times a day but is read millions of times?

### 14. Senior discussion
HTTP caching vs Redis caching vs client caching — Delivery Plus uses the last two. When would you add the first?

---

## Chapter 4 — Idempotency keys, pagination, filtering, sorting and search

### 1. Why this exists
Clients retry, and lists grow. Both need explicit API design.

### 2. Core concept
- **Idempotency key**: a client-generated unique key sent with a non-idempotent request; the server returns the original result for repeats. (Full treatment: [Book 08](08-idempotency-and-distributed-operations.md).)
- **Pagination**: offset (`page`, `limit`) or cursor/keyset (`after=<last id>`).
- **Filtering / sorting / search**: query parameters, validated and whitelisted.

### 3. Mental model
List endpoints are contracts about *stability*: if a new order arrives while you're on page 2, do you see it twice, or skip one?

### 4. Delivery Plus mapping — **CURRENT**
- `Idempotency-Key` on `POST /api/orders` and `POST /api/payments` (`services/order-service/src/common/idempotency-key.ts`, `services/payment-service/src/common/idempotency-key.ts`), backed by partial unique indexes `UQ_orders_customer_idempotency_key` and `UQ_payments_customer_idempotency_key`.
- The customer app creates one key per checkout attempt (`delivery-plus-customer-app/src/services/checkout.ts`).
- Offset pagination everywhere: `page`/`limit` DTOs (`services/order-service/src/dto/list-orders-query.dto.ts`, `services/restaurant-service/src/dto/list-restaurants-query.dto.ts`, `services/notification-service/src/dto/list-notifications-query.dto.ts`) → `skip/take` in repositories. Responses use `PaginatedResult { items, page, limit, total, totalPages }`.
- Search: `?search=` on restaurants → `ILIKE '%term%'`.

### 5. Example
```bash
curl -s "localhost:3000/api/restaurants?search=pizza&page=1&limit=10"
```

### 6. Failure scenario
Offset pagination on a feed that changes: a new notification arrives between page 1 and page 2, every item shifts by one, and the customer sees one notification twice. Keyset pagination doesn't have this problem.

### 7. Trade-offs
| | Offset | Keyset (cursor) |
| --- | --- | --- |
| Jump to page N | yes | no |
| Stable under inserts | no | yes |
| Cost at deep pages | O(offset) | O(log n) |
| `total` count | easy (but `COUNT(*)` is O(n)) | usually omitted |

### 8. Performance
`total` requires `COUNT(*)` — on large tables that alone can dominate the request. Many APIs drop exact totals for this reason.

### 9. Security
Cap `limit` (otherwise `limit=1000000` is a DoS). Whitelist sort fields (never interpolate a user's sort column into SQL).

### 10. Operations
Track p95 latency of list endpoints by page depth.

### 11. Lab
[DB-06 Offset vs keyset pagination](labs/database-labs.md#db-06-offset-vs-keyset-pagination).

### 12. Verification
You can show page 5,000 with offset is much slower than the equivalent keyset query.

### 13. Interview questions
- *Beginner:* What does an idempotency key protect against?
- *Intermediate:* Offset vs cursor pagination?
- *Advanced:* How do you return a stable cursor when sorting by a non-unique column?
- *Senior:* How long should idempotency keys be retained, and where?

### 14. Senior discussion
`PaginatedResult` returns `total` and `totalPages`. Would you keep them for notifications on a 100-million-row table?

---

## Chapter 5 — File uploads: multipart vs presigned URLs

### 1. Why this exists
Images are large and slow. Streaming them through the gateway and a service wastes CPU, memory and bandwidth, and makes services stateful.

### 2. Core concept
- **Multipart upload through the API**: client → gateway → service → storage. Simple, but every byte crosses your services.
- **Presigned upload**: the service *signs* a short-lived permission; the client uploads directly to object storage; the service then *confirms* the object.

### 3. Mental model
```text
1. App  → POST /api/users/me/avatar/image-upload-url   (service signs a POST policy: key prefix, type, size, 5 min)
2. App  → POST directly to S3 (pending/… key)          (bytes never touch the services)
3. App  → POST /api/users/me/avatar/confirm { key }    (service HEADs + checks bytes, copies to final key, saves URL)
```

### 4. Delivery Plus mapping — **CURRENT**
- Signing and verification: `shared/src/storage/s3-storage.service.ts` — allowed types JPEG/PNG/WebP, `UPLOAD_URL_TTL_SECONDS = 300`, `content-length-range` policy condition, uploads land under `pending/`, confirm checks the object (size, signed metadata, file signature) and copies it to a content-addressed key.
- Endpoints: avatar (`services/user-service/src/controllers/users.controller.ts`), restaurant images (`services/restaurant-service/src/controllers/restaurants.controller.ts`), menu-item images (`services/menu-service/src/controllers/menu.controller.ts`).
- Design write-up: `.project-context/15-media-and-storage.md`; case study [14](case-studies/14-s3-presigned-uploads.md); ADR [0007](adrs/0007-presigned-s3-uploads.md).

### 5. Example
The presigned POST policy pins the conditions; the storage server, not your code, enforces size and type at upload time.

### 6. Failure scenario
Trusting the client's declared `Content-Type`: an attacker uploads HTML as "image/png" and you serve it from your domain → stored XSS. Delivery Plus re-checks the stored bytes on confirm.

### 7. Trade-offs
Presigned uploads are scalable but two-step: an abandoned upload leaves an object in `pending/` (handled by a lifecycle expiry), and a crash after copy but before the DB write orphans an object (documented in `.project-context/15-media-and-storage.md`).

### 8. Performance — services handle two tiny JSON requests instead of megabytes of image data.
### 9. Security — key prefixes are bound to the requester (`users/<id>/avatar/…`); confirm rejects keys outside the expected prefix (the IDOR guard for files).
### 10. Operations — local URLs are `localhost:9000` (dev) / `:9100` (E2E), which phones and emulators cannot reach; production needs a public storage/CDN endpoint.

### 11. Lab
[SEC-05 Presigned upload end to end](labs/security-labs.md#sec-05-presigned-upload-end-to-end).

### 12. Verification
Uploading an oversized file is rejected by storage itself; confirming another user's key is rejected by the service.

### 13. Interview questions
- *Beginner:* What is a presigned URL?
- *Intermediate:* Why does the service need a confirm step?
- *Advanced:* How do you clean up abandoned uploads?
- *Senior:* How would you add virus scanning without blocking the user?

### 14. Senior discussion
Content-addressed keys (hash of the bytes) make duplicate uploads free and URLs immutable. What does that mean for cache invalidation and for deleting a user's data (GDPR)?

---

## Chapter 6 — Timeouts, retries, backoff and rate limiting

### 1. Why this exists
Networks fail partially: requests hang, fail half-way, or succeed after the client gave up. Without timeouts, one slow dependency freezes everything; without limits, one client can exhaust the system.

### 2. Core concept
- **Timeout**: give up after a bound. Every network call needs one.
- **Retry**: try again — only for errors that might succeed next time (timeouts, 502/503/504, connection reset) and only for idempotent operations.
- **Exponential backoff + jitter**: wait 100 ms, 200 ms, 400 ms… with randomness so clients don't retry in lockstep.
- **Rate limiting**: cap requests per identity per window. Algorithms: fixed window, sliding window, token bucket, leaky bucket.

### 3. Mental model
A timeout tells you **"I don't know"**, not "it failed". The server may have done the work. That ambiguity is why retries need idempotency.

### 4. Delivery Plus mapping
| Where | Timeout | Retry | Status |
| --- | --- | --- | --- |
| Customer app → gateway | 15 s `AbortController` (`REQUEST_TIMEOUT_MS` in `delivery-plus-customer-app/src/services/api.ts`) | user-driven ("Try again") | **CURRENT** |
| Gateway → service | none (`createProxyMiddleware` without `proxyTimeout`) | none | **PARTIAL** — issue #38 |
| Service → service (`fetch` in `services/*/src/common/*.client.ts`) | none | none | **PARTIAL** — issue #6 |
| Kafka handler | — | 3 attempts, 200 ms/400 ms backoff, then DLQ (`shared/src/kafka/kafka-consumer.service.ts`) | **CURRENT** |
| Rate limiting | fixed window in Redis: `ratelimit:{route}:{userId or IP}` (`shared/src/redis/rate-limit.guard.ts`) | 429 | **CURRENT** — auth routes 5/min, orders 5/min on create, cart 30/min |

### 5. Example
```text
fixed window, limit 5/min:
 12:00:59  5 requests  ✔ ✔ ✔ ✔ ✔
 12:01:00  window resets
 12:01:01  5 requests  ✔ ✔ ✔ ✔ ✔      → 10 requests in 2 seconds: the "boundary burst"
```

### 6. Failure scenario
**Retry storm**: a service slows down; every caller times out and retries 3×; load quadruples; the service collapses entirely. Backoff, jitter, retry budgets and circuit breakers prevent it ([Book 26](26-reliability-engineering.md)).

Also real in this code: `incrementAndCheck` runs `INCR` then, separately, `EXPIRE`. If the process dies between the two, the key has no TTL and that user is limited **forever** (until someone deletes the key). A Lua script or `SET key 0 EX w NX` + `INCR` makes it atomic. Lab [RD-04](labs/redis-labs.md#rd-04-fixed-window-rate-limiter).

### 7. Trade-offs
| Algorithm | Pro | Con |
| --- | --- | --- |
| Fixed window (current) | 1 counter, O(1) | boundary bursts |
| Sliding log | exact | O(requests) memory |
| Sliding window counter | smooth, cheap | approximate |
| Token bucket | allows controlled bursts | slightly more state |

### 8. Performance
Every rate-limited request costs 1–2 Redis round trips. Rate limiting in the gateway would protect services earlier (not implemented).

### 9. Security
IP-based limits (used for unauthenticated routes like login) are weak behind NAT and trivial to rotate around; account lockout (5 failures → 15 min, `services/auth-service/src/services/auth.service.ts`) complements them. Note that `request.ip` behind a proxy is the proxy's address unless `trust proxy` is configured — then every user shares one counter.

### 10. Operations
Count 429s per route; a sudden rise after a client release often means a polling bug in the app, not an attack.

### 11. Lab
[DS-01 Timeout ambiguity](labs/distributed-systems-labs.md#ds-01-timeout-ambiguity) and [RD-04 Fixed-window rate limiter](labs/redis-labs.md#rd-04-fixed-window-rate-limiter).

### 12. Verification
You produce a 429 at the documented limit, show the boundary burst, and show a key without TTL after simulating the crash.

### 13. Interview questions
- *Beginner:* Why must every network call have a timeout?
- *Intermediate:* Which HTTP errors are safe to retry?
- *Advanced:* Implement a token bucket in Redis atomically.
- *Senior:* Design retry and timeout budgets for a call chain app → gateway → order → cart.

### 14. Senior discussion
The customer app gives up after 15 s, but the gateway and services have no timeouts. What happens to the work the server keeps doing after the client has gone? Who pays for it?

---

## Chapter 7 — CORS, reverse proxies, TLS and connection reuse

### 1. Why this exists
Browsers restrict cross-origin requests; production traffic must be encrypted; opening a new TCP+TLS connection per request is slow.

### 2. Core concept
- **CORS**: the *browser* asks the server (preflight `OPTIONS`) whether a page from origin A may call origin B with these headers. It protects users' browsers, not your API.
- **Reverse proxy**: a server that forwards client requests to upstream servers (the API gateway is one).
- **TLS**: encryption + server authentication via certificates.
- **Keep-alive / connection pooling**: reuse TCP (and TLS) connections across requests.
- **HTTP/1.1** (one request at a time per connection), **HTTP/2** (multiplexed streams over one connection), **HTTP/3** (HTTP over QUIC/UDP, no TCP head-of-line blocking).

### 3. Mental model
```text
Browser (origin http://localhost:8083)
   │ preflight: OPTIONS /api/orders  Origin: http://localhost:8083  Access-Control-Request-Headers: authorization, idempotency-key
   ▼
Gateway: allowed origin? allowed headers? → 204 with Access-Control-Allow-* → browser sends the real POST
```

### 4. Delivery Plus mapping — **CURRENT**
- CORS: `getCorsOptions()` in `services/api-gateway/src/main.ts`. Default development origins are `localhost/127.0.0.1` on ports 8081–8084 (Expo web and the customer/driver E2E web servers); `NODE_ENV=production` refuses to start without `CORS_ORIGINS`.
- Reverse proxy: `http-proxy-middleware` with `changeOrigin: true`.
- TLS: **not in the repository** — local traffic is plain HTTP; production TLS would be terminated at a load balancer/ingress in front of the gateway (**FUTURE**, [Book 16](16-networking.md)).
- Internal hops use Docker DNS names (`http://order-service:3006`) — plain HTTP inside the Docker network.

### 5. Example
Remove `Idempotency-Key` from `allowedHeaders` and the web build's checkout breaks in the browser with a CORS error — while `curl` keeps working, because `curl` doesn't enforce CORS.

### 6. Failure scenario
"Fixing" CORS with `origin: '*'` plus credentials. Browsers refuse `*` with credentials; teams then reflect any `Origin` back — which effectively disables the protection for cookie-based auth.

### 7. Trade-offs
HTTP/2 reduces connection count and latency for many small requests; it needs TLS in practice for browsers. Internal service traffic stays HTTP/1.1 here, which is fine at this scale.

### 8. Performance
A new TCP connection costs 1 RTT; TLS 1.3 adds 1 more; on mobile that is 100–600 ms before the first byte. Keep-alive matters more than almost any code optimisation for mobile latency.

### 9. Security
CORS is not authentication. A server-side attacker or `curl` ignores it. Authorization must still happen in the services.

### 10. Operations
CORS errors appear only in the browser console; servers log a normal preflight. Teach support staff to ask for the browser console.

### 11. Lab
Send a preflight manually: `curl -i -X OPTIONS localhost:3000/api/orders -H 'Origin: http://localhost:8083' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,idempotency-key'`. Repeat with `Origin: http://evil.example`.

### 12. Verification
The first response contains `Access-Control-Allow-Origin: http://localhost:8083`; the second does not.

### 13. Interview questions
- *Beginner:* What problem does CORS solve, and for whom?
- *Intermediate:* What is a preflight request?
- *Advanced:* HTTP/2 vs HTTP/3?
- *Senior:* Where should TLS terminate in the Delivery Plus production design, and is internal traffic encrypted?

### 14. Senior discussion
Is a hand-rolled NestJS gateway the right choice for production, versus an off-the-shelf proxy (NGINX, Envoy, a cloud API gateway)? What do you gain and lose?

---

## Chapter 8 — Request/response vs events vs streaming connections

### 1. Why this exists
"How does the customer find out the order was delivered?" has several answers with very different costs.

### 2. Core concept
- **Polling**: client asks every N seconds.
- **Long polling**: server holds the request open until something changes or a timeout.
- **SSE** (Server-Sent Events): one long HTTP response streaming events server → client.
- **WebSockets**: a full-duplex connection upgraded from HTTP.
- **Events (Kafka)**: server-to-server asynchronous notification; not a client protocol.

### 3. Mental model
```text
                 latency          server cost             complexity
Polling 10 s     ≤ 10 s           1 req / 10 s / client   trivial
Long polling     ~instant         1 open req / client     medium
SSE              ~instant         1 open conn / client    medium (one-way)
WebSocket        ~instant         1 open conn / client    high (state, scaling, auth)
```

### 4. Delivery Plus mapping
- **CURRENT:** the order screen polls `GET /api/deliveries/by-order/:orderId` every 10 s while the delivery is active (`ACTIVE_DELIVERY_POLL_MS` in `delivery-plus-customer-app/src/state/deliveries.ts`), and stops when it is terminal.
- **CURRENT:** services talk to each other with HTTP (synchronous) and Kafka (asynchronous).
- **PLANNED/FUTURE:** WebSocket/SSE tracking ([Book 22](22-real-time-systems.md), [case study 12](case-studies/12-future-websocket-tracking.md), [ADR 0005](adrs/0005-polling-before-websockets.md)).

### 5. Example
Requests per hour for 10,000 customers with an active delivery: polling every 10 s = 3.6 million requests/hour (~1,000/s). WebSockets = 10,000 open connections and only the messages that actually change.

### 6. Failure scenario
WebSockets without heartbeats: mobile networks silently drop idle connections; the server thinks the client is connected, the client thinks it is subscribed, nobody receives anything.

### 7. Trade-offs
| Need | Best fit |
| --- | --- |
| Status changes every few minutes | polling |
| Server → client stream, simple infra | SSE |
| Two-way, high-frequency (driver location, chat) | WebSocket |
| Service → service | events or HTTP, not WebSockets |

### 8. Performance — see the example; also battery: radios waking every 10 s cost battery on phones.
### 9. Security — long-lived connections need authentication at connect *and* expiry handling (a 1 h JWT on a 10 h connection).
### 10. Operations — connections pin users to servers; deploys must drain them; load balancers need idle timeouts above heartbeat intervals.

### 11. Lab
Measure the polling: in the web build's network tab (or the gateway logs), count delivery requests while an order is in transit, then after it is delivered.

### 12. Verification
Requests appear every ~10 s during delivery and stop after `DELIVERED`.

### 13. Interview questions
- *Beginner:* Polling vs WebSockets?
- *Intermediate:* When is SSE better than WebSockets?
- *Advanced:* How do you scale WebSockets horizontally?
- *Senior:* What evidence would make you move delivery tracking from polling to WebSockets?

### 14. Senior discussion
If the driver app sends a location every 5 s and 1,000 customers watch their orders, which part of the system becomes the bottleneck first: ingestion, storage, or fan-out?

---

[Library index](README.md) · Previous: [Book 02](02-data-structures-and-algorithms.md) · Next: [Book 04 — Database Fundamentals](04-database-fundamentals.md)
