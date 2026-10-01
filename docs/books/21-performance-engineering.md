# Book 21 — Performance Engineering

[Library index](README.md) · Previous: [Book 20](20-observability.md) · Next: [Book 22 — Real-Time Systems](22-real-time-systems.md)

**Level:** Intermediate → Advanced · **Prerequisites:** [Book 02](02-data-structures-and-algorithms.md), [Book 05](05-postgresql-deep-dive.md), [Book 20](20-observability.md).

> **Measure first, optimize second.** Every chapter ends with a measurement. An optimisation you didn't measure is a guess with a commit message.

---

## Chapter 1 — Latency, throughput, concurrency and queueing

### 1. Why this exists
"Fast" means different things: one request quickly (latency) or many requests per second (throughput). They trade off through queues.

### 2. Core concept
- **Latency**: time for one operation; report percentiles (p50/p95/p99).
- **Throughput**: operations per second.
- **Concurrency**: operations in flight.
- **Little's Law**: `concurrency = throughput × latency`. 200 req/s at 50 ms → 10 in flight; at 500 ms → 100 in flight (and 100 DB connections if each holds one).
- **Queueing**: as utilisation approaches 100%, wait time explodes (it doesn't grow linearly). Keep key resources below ~70–80%.
- **Bottleneck**: the resource that saturates first sets the system's throughput.

### 3. Mental model
```text
latency
  │                         ╱
  │                       ╱
  │                    ╱
  │______________.___╱
  └────────────────────────── utilisation → 100%
```

### 4. Delivery Plus mapping — the PostgreSQL pool (10 per service) is a hard concurrency cap: at 10 in-flight DB operations per service process, further requests wait for a connection. With Little's Law: if a checkout holds a connection for 20 ms, one order-service process caps at ~500 DB-bound operations per second; if it holds it for 200 ms (a slow query), ~50.
### 5. Example — see the lab.
### 6. Failure scenario — "add more replicas" when the bottleneck is the single PostgreSQL server: more replicas = more connections = more contention = slower.
### 7. Trade-offs — batching raises throughput and latency; caching lowers latency and adds staleness.
### 8. Performance — this book.
### 9. Security — performance limits are availability limits; attackers find the slowest endpoint.
### 10. Operations — capacity = throughput at your latency SLO, not throughput at 100% CPU.

### 11. Lab — [OPS-05 Load test the restaurant list](labs/devops-labs.md#ops-05-load-test-the-restaurant-list).
### 12. Verification — you find the request rate where p95 latency starts climbing sharply and identify the saturated resource.

### 13. Interview questions
- *Beginner:* Latency vs throughput?
- *Intermediate:* State Little's Law and apply it to a DB pool.
- *Advanced:* Why does latency explode near 100% utilisation?
- *Senior:* How do you find the bottleneck in a 12-service system?

### 14. Senior discussion
Which Delivery Plus resource is the first bottleneck at 10× traffic: PostgreSQL connections, Redis CPU, Kafka partitions, or Node event loops?

---

## Chapter 2 — CPU-bound vs I/O-bound and profiling Node services

### 1. Why this exists
Node services are fast at waiting and slow at computing on the main thread.

### 2. Core concept
- **I/O-bound**: waiting on network/disk → Node shines (thousands of concurrent waits).
- **CPU-bound**: computing → blocks the event loop → all requests in that process wait.
- **Profiling**: CPU profiles (`node --cpu-prof`, Chrome DevTools via `--inspect`), flame graphs (0x, clinic flame), event-loop delay (`perf_hooks.monitorEventLoopDelay`).

### 3. Mental model — a flame graph's widest plateaus are where time goes; optimise those, nothing else.

### 4. Delivery Plus mapping
- Mostly I/O-bound: every service is "validate, call DB/Redis/another service, respond".
- CPU spots: bcrypt (off the main thread via libuv), JSON parse/stringify of carts/menus, JWT verification (cheap), future geo ranking (would be CPU-heavy).
### 5. Example
```bash
# run one service locally with a CPU profile (outside Docker), exercise it, then open the .cpuprofile in Chrome DevTools
node --cpu-prof services/menu-service/dist/main.js
```
### 6. Failure scenario — a synchronous loop over thousands of drivers inside a request handler raises every endpoint's p99 in that process.
### 7. Trade-offs — worker threads add complexity; moving CPU work to the database or Redis (server-side GEO search) often wins.
### 8. Performance — measure event-loop lag under load; > 50 ms p99 means the loop is blocked.
### 9. Security — CPU-heavy endpoints need tight rate limits.
### 10. Operations — profile in production with low-overhead sampling profilers when possible.

### 11. Lab — measure event-loop delay in menu-service while loading a large menu repeatedly (add a temporary `monitorEventLoopDelay` log locally; don't commit).
### 12. Verification — you correlate menu size with loop delay.

### 13. Interview questions
- *Beginner:* Why is Node good at I/O?
- *Intermediate:* What blocks the event loop?
- *Advanced:* How do you read a flame graph?
- *Senior:* When would you rewrite a hot path in another language?

### 14. Senior discussion
Is JSON the right wire format between internal services and in Kafka at higher volumes? What would Protobuf/Avro buy?

---

## Chapter 3 — Caching, batching, pooling, async processing and backpressure

### 1. Why this exists
These are the five standard levers once you know where time goes.

### 2. Core concept
- **Caching**: avoid recomputation/round trips (Book 06 Ch. 4).
- **Batching**: amortise per-call overhead (one query for N IDs, Kafka producer batching, batch offset commits).
- **Pooling**: reuse expensive connections.
- **Async processing**: move work off the request path (events).
- **Backpressure**: slow producers when consumers fall behind instead of buffering forever.

### 3. Mental model — remove work, then batch work, then parallelise work, then buy hardware.

### 4. Delivery Plus mapping
| Lever | Where | Status |
| --- | --- | --- |
| Cache | restaurants, menus, menu items in Redis; client SWR cache | **CURRENT** |
| Batch | Kafka commits per message; producer sends one message per call | **NOT USED** |
| Pool | PostgreSQL pool, ioredis connection, undici keep-alive | **CURRENT** |
| Async | notifications via Kafka | **CURRENT** |
| Backpressure | Kafka pull model; no HTTP-level shedding | **PARTIAL** |
### 5. Example — cart add-item calls menu-service (cached item) on every add; cache turns a DB query into a Redis GET.
### 6. Failure scenario — async without backpressure: an in-memory queue in a service grows until OOM during a downstream outage.
### 7. Trade-offs — each lever adds staleness, latency or complexity; pick by measurement.
### 8. Performance — this chapter.
### 9. Security — caches must not mix users' data.
### 10. Operations — monitor hit ratios, pool waits, queue depths.

### 11. Lab — [RD-03 Cache stampede on the menu](labs/redis-labs.md#rd-03-cache-stampede-on-the-menu).
### 12. Verification — warm-cache vs cold-cache latency for `GET /api/menus/restaurants/:id/menu`.

### 13. Interview questions
- *Beginner:* What does a connection pool save?
- *Intermediate:* Batching trade-offs?
- *Advanced:* What is backpressure?
- *Senior:* Which lever first for a slow checkout?

### 14. Senior discussion
Committing Kafka offsets per message is simple and slow. At what throughput would you switch to batch commits, and what changes about duplicates?

---

## Chapter 4 — Database performance

### 1. Why this exists
The database is usually the first shared bottleneck.

### 2. Core concept — indexes matching queries, avoiding N+1, keyset pagination, avoiding `COUNT(*)` on hot paths, short transactions, right-sized pools, read replicas for read-heavy paths.
### 3. Mental model — reduce rows touched, then round trips, then locks.
### 4. Delivery Plus mapping — hot queries (Book 05 Ch. 5): orders by customer (offset + `COUNT`), notifications by user (offset + `COUNT`), restaurant search (`ILIKE '%…%'`), available driver (`status` + `updatedAt` sort, no index), eager order items.
### 5. Example — adding `("userId", "createdAt" DESC)` to notifications and switching to keyset pagination turns deep pages from O(offset) to O(log n).
### 6. Failure scenario — `COUNT(*)` for `total` on every notifications request; at millions of rows per heavy user it dominates latency.
### 7. Trade-offs — more indexes slow writes; replicas add staleness.
### 8. Performance — Book 04/05 labs.
### 9. Security — slow queries are DoS vectors; set `statement_timeout`.
### 10. Operations — `pg_stat_statements` (not enabled) is the first tool to turn on in production.

### 11. Lab — [DB-03](labs/database-labs.md#db-03-index-vs-sequential-scan), [DB-06](labs/database-labs.md#db-06-offset-vs-keyset-pagination), [DB-08](labs/database-labs.md#db-08-trigram-search-vs-ilike).
### 12. Verification — before/after `EXPLAIN ANALYZE` timings for each.

### 13. Interview questions
- *Beginner:* Why is an index faster?
- *Intermediate:* N+1 — detect and fix?
- *Advanced:* When does a read replica help?
- *Senior:* Performance review checklist for new queries.

### 14. Senior discussion
`PaginatedResult.total` is part of the public API. Would you deprecate it, make it approximate, or cache it?

---

## Chapter 5 — Load, stress and benchmark design

### 1. Why this exists
A benchmark that doesn't resemble reality produces confident wrong answers.

### 2. Core concept
- Define the question (capacity? regression? breaking point?).
- Realistic data volume and distribution; realistic mix of requests.
- Warm-up, steady state, sufficient duration; open-model load (arrival rate) vs closed-model (fixed users).
- Report percentiles and errors, not just averages; record environment.
- Coordinated omission: closed-model tools under-report latency when the system stalls.

### 3. Mental model — a benchmark is an experiment: hypothesis, controlled variables, measurement, conclusion.
### 4. Delivery Plus mapping — **NOT IMPLEMENTED** in the repo; the labs use `autocannon`/`k6` against the dev stack. Rate limits (orders 5/min, cart 30/min per user) must be accounted for: use many seeded users or a test-only configuration.
### 5. Example
```bash
npx autocannon -c 50 -d 30 "http://localhost:3000/api/restaurants?page=1&limit=20"
```
### 6. Failure scenario — load-testing on a laptop where the load generator competes with the 20 containers for CPU; results measure the laptop, not the system.
### 7. Trade-offs — local tests show relative changes; absolute capacity needs production-like infrastructure.
### 8. Performance — this chapter.
### 9. Security — never point load tests at third-party services.
### 10. Operations — keep benchmark scripts in the repo and run them on a schedule to catch regressions.

### 11. Lab — [OPS-05 Load test the restaurant list](labs/devops-labs.md#ops-05-load-test-the-restaurant-list).
### 12. Verification — a short report: setup, load model, p50/p95/p99, errors, bottleneck.

### 13. Interview questions
- *Beginner:* What is a load test?
- *Intermediate:* Open vs closed load models?
- *Advanced:* What is coordinated omission?
- *Senior:* Design a performance regression gate in CI.

### 14. Senior discussion
What is the single most valuable benchmark to add to CI for Delivery Plus?

---

## Chapter 6 — Applying it: the hot paths of Delivery Plus

| Path | Current shape | First measurement | Likely first optimisation |
| --- | --- | --- | --- |
| **Restaurant search** | `ILIKE '%term%'`, offset, `COUNT`, cached per restaurant only | p95 vs number of restaurants | trigram GIN index; cache search results briefly ([DB-08](labs/database-labs.md#db-08-trigram-search-vs-ilike)) |
| **Driver selection** | `status = AVAILABLE ORDER BY updatedAt DESC LIMIT 1` | plan with 100k drivers | index `(status, "updatedAt" DESC)`; later Redis GEO ([Book 23](23-geo-location-systems.md)) |
| **Tracking read** | delivery-service + driver-service + Redis per poll | requests/s at 10k active orders polling every 10 s (~1,000/s) | cache the delivery→driver mapping; push instead of poll ([Book 22](22-real-time-systems.md)) |
| **Checkout** | app → order (cart, restaurant, DB, cart clear, Kafka) → payment (order, DB, Kafka, order sync) | hop-by-hop latency (needs tracing) | parallelise independent calls; shorten synchronous chain |
| **Kafka consumers** | one partition, per-message commit, 2 Redis calls per event | max events/s per group | batch commits; more partitions + replicas |
| **DB queries** | offset pagination + totals | deep-page latency | keyset pagination; composite indexes |

Lab: pick one row, measure, change one thing, measure again, write the result in a PR description.

---

[Library index](README.md) · Previous: [Book 20](20-observability.md) · Next: [Book 22 — Real-Time Systems](22-real-time-systems.md)
