# Book 06 — Redis

[Library index](README.md) · Previous: [Book 05](05-postgresql-deep-dive.md) · Next: [Book 07 — Kafka](07-kafka.md)

**Level:** Intermediate → Advanced · **Prerequisites:** [Book 02](02-data-structures-and-algorithms.md) (hash maps, sorted structures), [Book 04](04-database-fundamentals.md) (transactions).

Redis 7 (`redis:7-alpine`, `docker-compose.base.yml`) is the platform's fast, shared memory. In Delivery Plus it holds carts, rate-limit counters, cached restaurants and menus, driver locations, internal-auth nonces and Kafka idempotency markers. This book explains what Redis really is and where each of those uses is strong or fragile.

```bash
alias dc='docker compose -f docker-compose.base.yml -f docker-compose.dev.yml'
dc exec redis redis-cli
```

**Every Redis key pattern in the codebase — CURRENT:**

| Key | Type / TTL | Owner | File |
| --- | --- | --- | --- |
| `cart:{userId}` | string (JSON), `CART_TTL_SECONDS` = 86400 | cart-service | `services/cart-service/src/repositories/cart.repository.ts` |
| `ratelimit:{routePath}:{userId or IP}` | integer counter, TTL = window | every rate-limited service | `shared/src/redis/rate-limit.guard.ts`, `shared/src/redis/rate-limiter.service.ts` |
| `restaurant:{id}`, `menu:{restaurantId}`, `menuitem:{id}` | string (JSON), cache | restaurant-, menu-service | `shared/src/redis/cache.service.ts` |
| `driver:location:{userId}` | string (JSON), `LOCATION_TTL_SECONDS` = 300 | tracking-service | `services/tracking-service/src/repositories/location.repository.ts` |
| `internal-auth:nonce:{service}:{nonce}` | string, 600 s, `SET NX` | user-service | `services/user-service/src/guards/internal-auth.guard.ts` |
| `kafka:idempotency:{group}:{eventId}` | `lease:<token>` (60 s) or `processed` (7 days) | order-, notification-service consumers | `shared/src/kafka/durable-event-idempotency.service.ts` |

Persistence: `redis-server --appendonly yes` with the `redis_data` volume (`docker-compose.base.yml`). **All services share one Redis instance** (database 0).

---

## Chapter 1 — What Redis actually is

### 1. Why this exists
Some data is needed on every request, changes constantly, or is short-lived. PostgreSQL can store it, but each access costs a disk-backed, MVCC-versioned transaction. Redis trades durability guarantees for speed and simple atomic operations.

### 2. Core concept
- An **in-memory data-structure server**: keys map to typed values (string, hash, list, set, sorted set, stream, geo).
- **Single-threaded command execution**: each command runs to completion before the next starts → every single command is atomic. (I/O threads exist; execution is still serial.)
- Network protocol: request/response over TCP; pipelining sends many commands per round trip.

### 3. Mental model
Redis is a shared, networked hash map whose values are data structures, with a stopwatch on each key (TTL) and optional journaling to disk.

### 4. Delivery Plus mapping — **CURRENT**
`RedisModule.register({ url })` in `shared/src/redis/redis.module.ts` creates one `ioredis` client per service process and exposes it as `REDIS_CLIENT`, plus `CacheService`, `RateLimiterService` and `RateLimitGuard`.

### 5. Example
```text
127.0.0.1:6379> KEYS cart:*            # never in production (blocks); SCAN instead
127.0.0.1:6379> GET cart:<customer-id>
127.0.0.1:6379> TTL cart:<customer-id>
```

### 6. Failure scenario
`KEYS *` on a production instance with millions of keys blocks the single execution thread for seconds: every service's cart, rate-limit and idempotency calls stall. Use `SCAN` with a cursor.

### 7. Trade-offs
| | Redis | PostgreSQL |
| --- | --- | --- |
| Latency | ~0.1–1 ms | ~1–5 ms |
| Durability | configurable, weaker | strong (WAL, fsync per commit) |
| Queries | by key only (plus structure ops) | arbitrary SQL |
| Memory | dataset must fit in RAM | disk-based |

### 8. Performance
Most commands are O(1) or O(log n). The cost is the round trip: pipelining or Lua turns N round trips into one.

### 9. Security
Local Redis has no password and no TLS. Anyone on the Docker network can read carts and forge idempotency markers. Production needs `requirepass`/ACLs, network isolation and, across hosts, TLS ([Book 17](17-security-engineering.md)).

### 10. Operations
One instance for everything means one failure domain: when Redis is down, carts, rate-limited routes (the guard throws → 500), Kafka consumers (claims fail → nothing commits), tracking and user registration (nonce check) all fail together.

### 11. Lab
[RD-01 Tour the keyspace](labs/redis-labs.md#rd-01-tour-the-keyspace).

### 12. Verification
You find one key of each pattern in the table above (after `npm run seed` and `npm run e2e`) and state its TTL.

### 13. Interview questions
- *Beginner:* Why is Redis fast?
- *Intermediate:* Why is a single Redis command atomic?
- *Advanced:* What happens to Delivery Plus if Redis restarts?
- *Senior:* Would you split this Redis into several instances? By what criteria?

### 14. Senior discussion
Carts, caches and idempotency markers have very different durability needs but share one instance and one persistence policy. Is that a reasonable simplification at current scale?

---

## Chapter 2 — Data structures and when to use each

### 1. Why this exists
Using a string of JSON for everything works — until you need to update one field atomically or query by score.

### 2. Core concept
| Type | Ops | Use |
| --- | --- | --- |
| String | `GET/SET/INCR/SETNX` | values, counters, locks |
| Hash | `HGET/HSET/HINCRBY` | objects with independently updated fields |
| List | `LPUSH/RPOP/LRANGE` | simple queues, recent items |
| Set | `SADD/SISMEMBER` | membership, dedup |
| Sorted set | `ZADD/ZRANGEBYSCORE` | ranking, time-ordered data, sliding windows |
| Stream | `XADD/XREADGROUP/XACK` | durable-ish event log with consumer groups |
| GEO | `GEOADD/GEOSEARCH` (a sorted set with geohash scores) | nearby search |

### 3. Mental model
Choose the structure so that the *operation you need* is one atomic command.

### 4. Delivery Plus mapping
- **CURRENT:** everything is a **string** (JSON blobs or integers).
- **Consequence:** updating one cart line = read the whole JSON, modify in the app, write the whole JSON (Chapter 6).
- **FUTURE alternatives:** cart as a **hash** (`HINCRBY cart:{u} {menuItemId} 1`), driver availability as a **GEO** set, rate limits as **sorted-set** sliding windows, tracking fan-out via **streams** or **pub/sub** ([Book 22](22-real-time-systems.md)).

### 5. Example
```text
HINCRBY cart:u1 item:burger 1     # atomic, no read-modify-write
HGETALL cart:u1
```

### 6. Failure scenario — see Chapter 6 (lost cart update).
### 7. Trade-offs — JSON strings are simple and match the TypeScript model; hashes are atomic per field but need mapping code and can't hold nested structures.
### 8. Performance — `HGETALL` is O(fields); fine for carts, bad for hashes with millions of fields.
### 9. Security — structure choice doesn't change access control: Redis has key-pattern ACLs (Redis 6+) but none are used.
### 10. Operations — `MEMORY USAGE key`, `--bigkeys` to find oversized values.

### 11. Lab
[RD-02 Lost update in the cart](labs/redis-labs.md#rd-02-lost-update-in-the-cart) — reproduce, then fix with a hash or `WATCH`.

### 12. Verification
Two concurrent adds via the API lose one item; the hash version never does.

### 13. Interview questions
- *Beginner:* String vs hash?
- *Intermediate:* What is a sorted set used for?
- *Advanced:* How is Redis GEO implemented?
- *Senior:* Redesign the cart's Redis model; what migrates, and how do you deploy it without losing live carts?

### 14. Senior discussion
Should the cart live in Redis at all? What would PostgreSQL give you (durability, history, analytics) and cost you? See [ADR 0002](adrs/0002-redis-for-carts.md).

---

## Chapter 3 — TTL, expiration, persistence (RDB/AOF) and eviction

### 1. Why this exists
In-memory data must end somewhere: expire, be evicted, or be written to disk.

### 2. Core concept
- **TTL**: per-key expiry (`EX`, `EXPIRE`). Redis expires keys lazily (on access) and actively (sampling).
- **RDB**: periodic point-in-time snapshots — compact, fast restart, loses everything since the last snapshot.
- **AOF**: append-only log of writes; `appendfsync everysec` (default) loses ≤ ~1 s on crash; rewritten in the background to stay small.
- **Eviction policy** when `maxmemory` is reached: `noeviction` (writes fail), `allkeys-lru`, `volatile-lru` (only keys with TTL), `allkeys-lfu`, …

### 3. Mental model
TTL decides *when data stops being true*; eviction decides *what to drop when memory is full*; persistence decides *what survives a restart*.

### 4. Delivery Plus mapping — **CURRENT**
- AOF enabled (`--appendonly yes`, default `everysec`) with the `redis_data` volume — added so carts and processed-event markers survive restarts ([Book 07](07-kafka.md)).
- No `maxmemory` set → Redis uses all available memory; default policy `noeviction`.
- TTLs: carts 24 h, locations 300 s, nonces 600 s, idempotency leases 60 s / processed markers 7 days, rate-limit counters = window. Cache keys get the TTL their caller passes: `restaurant:{id}` 30 s (`services/restaurant-service/src/services/restaurants.service.ts`), `menu:{restaurantId}` and `menuitem:{id}` 60 s (`services/menu-service/src/services/menu.service.ts`), plus explicit invalidation on writes.

### 5. Example
```text
CONFIG GET appendonly        → yes
CONFIG GET maxmemory-policy  → noeviction
TTL driver:location:<driverUserId>
```

### 6. Failure scenario
With `noeviction` and no `maxmemory`, data grows faster than it expires (24-hour carts for every visitor, 7-day idempotency markers, a bulk import of menus) until the container's memory limit: the kernel OOM-kills Redis, and every Redis-dependent feature fails at once. Setting `maxmemory` + `volatile-lru` would sacrifice only keys with TTL — but carts and idempotency markers *also* have TTLs, so an eviction could drop a processed marker and allow a duplicate side effect. Eviction policy is a correctness decision here, not just a performance one.

### 7. Trade-offs
| Persistence | Data loss on crash | Restart time | Disk I/O |
| --- | --- | --- | --- |
| none | everything | instant | none |
| RDB every 5 min | ≤ 5 min | fast | bursts |
| AOF everysec (current) | ≤ ~1 s | slower (replay) | continuous |
| AOF always | ~none | slower | heavy |

### 8. Performance — AOF rewrite and RDB `fork()` can cause latency spikes on large datasets (copy-on-write memory).
### 9. Security — AOF/RDB files on disk contain everything in Redis; protect the volume.
### 10. Operations — monitor `used_memory`, evicted keys, AOF rewrite failures, `rejected_connections`.

### 11. Lab
[RD-05 Restart Redis with and without AOF](labs/redis-labs.md#rd-05-restart-redis-with-and-without-aof).

### 12. Verification
With AOF your cart survives `dc restart redis`; with persistence disabled it doesn't.

### 13. Interview questions
- *Beginner:* What is a TTL?
- *Intermediate:* RDB vs AOF?
- *Advanced:* Why is `volatile-lru` risky for idempotency markers?
- *Senior:* Choose persistence and eviction for each Redis use in Delivery Plus.

### 14. Senior discussion
Would you move idempotency markers to PostgreSQL (durable, transactional with the side effect) and keep Redis only for caches and counters? What would that cost in latency?

---

## Chapter 4 — Caching patterns and invalidation

### 1. Why this exists
Restaurant and menu data are read on almost every customer screen and change rarely — a textbook cache case.

### 2. Core concept
- **Cache-aside** (lazy loading): read cache → on miss read DB and fill cache. Writers update DB then delete the cache key.
- **Write-through**: writers update cache and DB together.
- **Write-behind**: writers update cache; cache persists to DB later (risky).
- **Invalidation**: delete or update on write; or TTL; or versioned keys.
- **Stampede / dogpile**: many concurrent misses rebuild the same key.

### 3. Mental model
"There are only two hard things in computer science: cache invalidation and naming things." The hard part is the *window* between the DB write and the cache delete.

### 4. Delivery Plus mapping — **CURRENT: cache-aside**
- `CacheService.getOrSet(key, fetchFn, ttl?)` in `shared/src/redis/cache.service.ts`.
- restaurant-service caches `restaurant:{id}` and deletes it on update/status change (`services/restaurant-service/src/services/restaurants.service.ts`).
- menu-service caches `menu:{restaurantId}` and `menuitem:{id}` and deletes both on create/update/delete/availability/image changes (`services/menu-service/src/services/menu.service.ts`).
- Weaknesses: no stampede protection; falsy cached values are treated as misses (`if (cached)`). A short TTL (30–60 s) backs up explicit invalidation, so a missed delete is stale for at most a minute.

### 5. Example — the race in cache-aside
```text
t1  Reader A: cache miss → reads menu v1 from DB
t2  Writer B: updates menu to v2 in DB → DEL menu:r1
t3  Reader A: SET menu:r1 = v1          ← stale value written after the delete
```
A short TTL bounds how long that staleness lives.

### 6. Failure scenario
Item availability is cached in `menu:{restaurantId}`. If invalidation fails (Redis blip after the DB write), customers keep seeing a sold-out item as available for up to the 60 s TTL, the cart accepts it (cart-service checks `item.available` from `menuitem:{id}` via menu-service), and checkout does not re-validate (issue #42).

### 7. Trade-offs
| Pattern | Freshness | Write cost | Complexity |
| --- | --- | --- | --- |
| Cache-aside + delete only | short race window | low | low |
| + TTL backstop (current) | bounded staleness | low | low |
| Write-through | fresh | higher | medium |
| Versioned keys | no races | storage | medium |

### 8. Performance — measure hit ratio; a cache that misses 90% only adds latency.
### 9. Security — never cache authorization decisions keyed only by resource ID.
### 10. Operations — cold cache after a Redis restart = DB load spike; warm critical keys or accept it.

### 11. Lab
[RD-03 Cache stampede on the menu](labs/redis-labs.md#rd-03-cache-stampede-on-the-menu).

### 12. Verification
You count DB queries during 200 concurrent requests on a cold key, then reduce them to one with a lock/single-flight.

### 13. Interview questions
- *Beginner:* What is cache-aside?
- *Intermediate:* Why delete the key instead of updating it on write?
- *Advanced:* Describe the stale-write race and two fixes.
- *Senior:* Where would you *stop* caching in this system?

### 14. Senior discussion
Should cache invalidation be driven by Kafka events (`menu.item_updated`) instead of the writer deleting keys? What do you gain and what new failure modes appear?

---

## Chapter 5 — Counters and rate limiting

### 1. Why this exists
Brute force on login, accidental client loops, and abusive scripts must be throttled before they reach expensive work.

### 2. Core concept
- `INCR` is atomic → a natural counter.
- **Fixed window**: one counter per window, `INCR` + `EXPIRE`.
- **Sliding window log**: sorted set of timestamps, `ZREMRANGEBYSCORE` + `ZCARD`.
- **Token bucket**: refill tokens at a rate; each request takes one (Lua for atomicity).

### 3. Mental model
A rate limiter is a decision function `(identity, route, now) → allow/deny` whose state must be shared by all replicas — hence Redis.

### 4. Delivery Plus mapping — **CURRENT**
- `RateLimitGuard` (`shared/src/redis/rate-limit.guard.ts`) builds `ratelimit:{request.route.path}:{user.sub || ip}`; reads `@RateLimit` from the handler, else the controller class (that class-level fallback was a bug fix — [case study 05](case-studies/05-rate-limit-mismatch.md)).
- `RateLimiterService.incrementAndCheck`: `INCR`, then `EXPIRE` when the count is 1.
- Limits: auth register/login/verify/resend 5 per 60 s (`services/auth-service/src/controllers/auth.controller.ts`), order create 5/60 s and order status 10/60 s (`services/order-service/src/controllers/orders.controller.ts`), cart 30/60 s (`services/cart-service/src/controllers/cart.controller.ts`).
- The rate limiter **fails closed**: if Redis is down, the guard throws and the request fails.

### 5. Example — the atomicity gap
```text
INCR ratelimit:/login:1.2.3.4   → 1
<process crashes here>
EXPIRE never runs → key lives forever → after 5 requests this IP is blocked permanently
```
Atomic version:
```lua
-- KEYS[1]=key ARGV[1]=window
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
```

### 6. Failure scenario
Behind a load balancer without `trust proxy`, `request.ip` is the balancer's IP: **all** anonymous users share one login counter, and 5 failed logins anywhere block everyone's login for a minute.

### 7. Trade-offs — fail closed (safer, less available) vs fail open (available, unprotected during a Redis outage). Login should probably fail closed; browsing could fail open.
### 8. Performance — 1–2 Redis round trips per protected request.
### 9. Security — rate limits complement, not replace, account lockout (5 failed passwords → 15 min in auth-service).
### 10. Operations — dashboards of 429s by route; an allow-list for internal health checks.

### 11. Lab
[RD-04 Fixed-window rate limiter](labs/redis-labs.md#rd-04-fixed-window-rate-limiter).

### 12. Verification
You show the 429 at request 31 on the cart, the boundary burst, and a key without TTL after simulating a crash between `INCR` and `EXPIRE`.

### 13. Interview questions
- *Beginner:* What does a 429 mean?
- *Intermediate:* Fixed vs sliding window?
- *Advanced:* Make the limiter atomic in one round trip.
- *Senior:* Where should rate limiting live: gateway, service, or both?

### 14. Senior discussion
Identifier = `user.sub` for authenticated routes means one customer on two devices shares a budget, and one shared NAT IP means many customers share a budget on public routes. How would you design identities for the driver app?

---

## Chapter 6 — Atomicity, Lua, WATCH and distributed locks

### 1. Why this exists
Read-modify-write across two Redis commands is a race, exactly like in SQL.

### 2. Core concept
- Single commands are atomic.
- **`MULTI/EXEC`** queues commands and executes them together (no rollback, no conditional logic).
- **`WATCH key` + `MULTI/EXEC`**: optimistic locking — `EXEC` fails if the watched key changed.
- **Lua scripts** (`EVAL`): run atomically on the server; can read, decide and write.
- **Distributed lock**: `SET lock:x <token> NX PX 30000`; release only if the value is still your token (Lua). Locks with expiry need **fencing tokens** to be safe ([Book 09](09-distributed-systems.md)).

### 3. Mental model
If the decision depends on a value you read, the read and the write must be one atomic unit.

### 4. Delivery Plus mapping
- **CURRENT, done right:** `DurableEventIdempotencyService` uses three Lua scripts (`shared/src/kafka/durable-event-idempotency.scripts.ts`): acquire (`SET NX PX` or report `processed`/`in-progress`), mark processed (owner-checked), release (only by the owner token). It even handles ioredis re-sending an acquire after a reconnect.
- **CURRENT, done right:** nonce replay protection uses one `SET key 1 EX 600 NX` (`services/user-service/src/guards/internal-auth.guard.ts`).
- **CURRENT, racy:** cart updates are `GET` → modify in Node (with an HTTP call to menu-service in between) → `SET`. Two concurrent adds lose one; two concurrent adds from different restaurants can both pass the one-restaurant check.

### 5. Example — cart fix with WATCH
```text
WATCH cart:u1
GET cart:u1            → modify in app
MULTI
SET cart:u1 <new json> EX 86400
EXEC                   → nil if someone changed cart:u1 since WATCH → retry
```

### 6. Failure scenario
A lock with a TTL that expires while the holder is still working (GC pause, slow network) → a second holder enters → both write. Without a fencing token checked by the *resource*, a Redis lock is a performance optimisation, not a correctness guarantee.

### 7. Trade-offs
| Technique | Good for | Limits |
| --- | --- | --- |
| Single atomic command | counters, set-if-absent | simple logic only |
| WATCH/MULTI | optimistic read-modify-write | retries under contention |
| Lua | complex atomic logic | blocks Redis while running; keep short |
| Redlock / locks | mutual exclusion "mostly" | not safe without fencing |

### 8. Performance — a Lua script is one round trip regardless of how many commands it runs.
### 9. Security — `EVAL` executes server-side code; restrict who can run scripts with ACLs.
### 10. Operations — slow Lua scripts appear in `SLOWLOG GET`.

### 11. Lab
[RD-02 Lost update in the cart](labs/redis-labs.md#rd-02-lost-update-in-the-cart), [RD-07 Idempotency lease with Lua](labs/redis-labs.md#rd-07-idempotency-lease-with-lua).

### 12. Verification
You show two "in-progress" claimants cannot both acquire the same event, and that only the owner token can release it.

### 13. Interview questions
- *Beginner:* Is `INCR` atomic?
- *Intermediate:* WATCH vs Lua?
- *Advanced:* Why are Redis locks unsafe without fencing tokens?
- *Senior:* When would you choose a database row lock over a Redis lock?

### 14. Senior discussion
The idempotency service records "processed" *after* the side effect commits in PostgreSQL. What happens if the process dies between the two? (Answer in [Book 08](08-idempotency-and-distributed-operations.md).)

---

## Chapter 7 — Idempotency records and nonces in Redis

### 1. Why this exists
Retries and redeliveries are normal; side effects must not repeat. Redis is a fast place to remember "I've already done this".

### 2. Core concept
Store a key per operation (`eventId`, request nonce, idempotency key) with a TTL long enough to cover the redelivery window. Claim it atomically before doing the work.

### 3. Mental model
```text
claim(eventId) ── acquired ──► do work ──► mark processed ──► commit offset
              ├─ processed ──► skip, commit
              └─ in-progress ► wait (another consumer is on it)
```

### 4. Delivery Plus mapping — **CURRENT**
- Kafka consumers in order-service and notification-service (`KafkaModule.register({ durableIdempotency: true })`), keys `kafka:idempotency:{consumerGroup}:{eventId}`, lease 60 s, retention 7 days (matches Kafka's default retention).
- Internal service auth nonces: replay of a signed request within 10 minutes is rejected.
- HTTP idempotency keys for orders and payments are **not** in Redis — they are in PostgreSQL unique indexes, next to the data they protect.

### 5. Example — see [Book 08](08-idempotency-and-distributed-operations.md) for the full flow and failure analysis.
### 6. Failure scenario — Redis restart without persistence drops all processed markers; a consumer rewind after that re-runs side effects. That is why AOF was enabled.
### 7. Trade-offs — Redis markers are fast and shared but not transactional with PostgreSQL side effects; a DB "inbox" table is transactional but slower ([Book 27](27-advanced-data-patterns.md)).
### 8. Performance — one Lua call per event.
### 9. Security — anyone who can write to Redis can mark an event processed and suppress it.
### 10. Operations — key count ≈ events per 7 days × consumer groups; size it.

### 11. Lab
[KF-07 Redelivery after restart is skipped](labs/kafka-labs.md#kf-07-redelivery-after-restart-is-skipped).

### 12. Verification
After rewinding notification-service's offsets, redelivered events are logged as "already processed" and no duplicate notification rows appear.

### 13. Interview questions
- *Beginner:* What is a nonce?
- *Intermediate:* Why does each consumer group need its own idempotency key?
- *Advanced:* How long must idempotency markers live?
- *Senior:* Redis markers vs a PostgreSQL inbox table for notification-service?

### 14. Senior discussion
HTTP idempotency keys live in PostgreSQL, event idempotency in Redis. Is that inconsistency justified?

---

## Chapter 8 — Geospatial data and current location

### 1. Why this exists
"Where is the driver now?" changes every few seconds and is only interesting while fresh.

### 2. Core concept
- A per-entity key with a TTL models "last known state, expires when stale".
- **Redis GEO** stores members in a sorted set scored by a 52-bit geohash; `GEOSEARCH` finds members within a radius or box, sorted by distance.

### 3. Mental model
Current location is a *cache of reality* with an expiry, not a record.

### 4. Delivery Plus mapping
- **CURRENT:** `POST /api/tracking/location` stores `{ userId, latitude, longitude, updatedAt }` at `driver:location:{userId}` for 300 s; `GET /api/tracking/delivery/:deliveryId` resolves delivery → driver → location (`services/tracking-service/src/services/tracking.service.ts`).
- **FUTURE:** a GEO set of available drivers for nearest-driver search ([Book 23](23-geo-location-systems.md), [ADR 0003](adrs/0003-redis-for-current-location.md)).

### 5. Example
```text
GEOADD drivers:available 31.2357 30.0444 driver-1
GEOSEARCH drivers:available FROMLONLAT 31.24 30.05 BYRADIUS 3 km ASC COUNT 5 WITHDIST
```

### 6. Failure scenario
GEO members have no individual TTL. A driver whose app crashes stays "available" in the GEO set forever unless something removes them — unlike `driver:location:{userId}`, which expires.

### 7. Trade-offs — Redis GEO vs PostGIS vs H3, see [Book 23](23-geo-location-systems.md).
### 8. Performance — `GEOSEARCH` is O(N + log M) where N is results in the area.
### 9. Security — location is sensitive personal data; TTL is also a privacy feature.
### 10. Operations — location writes are the highest-frequency write in a delivery platform; Redis absorbs them better than PostgreSQL.

### 11. Lab
[RD-06 Redis GEO nearest drivers](labs/redis-labs.md#rd-06-redis-geo-nearest-drivers).

### 12. Verification
`GEOSEARCH` returns drivers in distance order and matches your Haversine computation within metres.

### 13. Interview questions
- *Beginner:* Why give location keys a TTL?
- *Intermediate:* How does Redis GEO store coordinates?
- *Advanced:* How do you expire members of a GEO set?
- *Senior:* Design location ingestion for 50,000 drivers updating every 5 s.

### 14. Senior discussion
Should location history (for disputes, ETA training) be stored at all? Where, for how long, and who may read it?

---

## Chapter 9 — Pub/Sub vs Streams, and Redis high availability

### 1. Why this exists
Real-time features and resilience both raise questions Redis can answer in several ways.

### 2. Core concept
- **Pub/Sub**: fire-and-forget fan-out; subscribers that are offline miss messages.
- **Streams**: an append-only log with consumer groups, acknowledgements and pending entries — like a small Kafka inside Redis.
- **Replication**: async replicas. **Sentinel**: monitors and fails over a primary. **Cluster**: shards keys across nodes (16,384 hash slots); multi-key operations must stay in one slot.

### 3. Mental model
Pub/Sub = radio broadcast. Streams = recorded messages with read receipts.

### 4. Delivery Plus mapping
- **NOT USED:** Pub/Sub, Streams, Sentinel, Cluster. One standalone instance.
- **FUTURE:** Pub/Sub for pushing location updates to WebSocket servers ([Book 22](22-real-time-systems.md)).

### 5. Example
```text
SUBSCRIBE delivery:123      # terminal 1
PUBLISH delivery:123 '{"lat":30.04,"lng":31.23}'   # terminal 2
```

### 6. Failure scenario
Async replication + failover: the primary acknowledged a processed-marker write, crashed before replicating; the promoted replica doesn't have it; a redelivered event runs twice.

### 7. Trade-offs
| Need | Choice |
| --- | --- |
| Live location fan-out, loss acceptable | Pub/Sub |
| Must not lose, small scale | Streams |
| Must not lose, big scale, replay, many consumers | Kafka (already present) |

### 8. Performance — Pub/Sub delivers to every subscriber; slow subscribers buffer in Redis memory (output-buffer limits disconnect them).
### 9. Security — channel names are not secret; authorize at the WebSocket layer, not in Redis.
### 10. Operations — Sentinel/Cluster need client support (ioredis supports both) and failover testing.

### 11. Lab
[RD-08 Pub/Sub vs Streams](labs/redis-labs.md#rd-08-pubsub-vs-streams).

### 12. Verification
A subscriber started after `PUBLISH` receives nothing; a stream reader started later still reads the entry.

### 13. Interview questions
- *Beginner:* Pub/Sub vs a queue?
- *Intermediate:* What do Redis Streams add over Pub/Sub?
- *Advanced:* Cross-slot errors in Redis Cluster — when and why?
- *Senior:* Would you use Redis Streams or Kafka for driver location events?

### 14. Senior discussion
At what point does "one Redis for everything" become the platform's biggest single point of failure, and what is the cheapest step up (persistence → replica + Sentinel → split by use case → managed service)?

---

[Library index](README.md) · Previous: [Book 05](05-postgresql-deep-dive.md) · Next: [Book 07 — Kafka](07-kafka.md)
