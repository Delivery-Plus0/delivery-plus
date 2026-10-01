# Book 05 — PostgreSQL Deep Dive

[Library index](README.md) · Previous: [Book 04](04-database-fundamentals.md) · Next: [Book 06 — Redis](06-redis.md)

**Level:** Intermediate → Advanced · **Prerequisites:** [Book 04](04-database-fundamentals.md).

Delivery Plus runs `postgres:16-alpine` (`docker-compose.base.yml`). This book opens the box: processes, memory, MVCC, vacuum, index types, the planner, locks and recovery — always with commands you can run against the local container.

```bash
alias dc='docker compose -f docker-compose.base.yml -f docker-compose.dev.yml'
dc exec postgres psql -U postgres -d order_service
```

---

## Chapter 1 — Architecture: processes, memory and the WAL

### 1. Why this exists
Tuning, capacity planning and incident response all require knowing *what* PostgreSQL is doing with CPU, memory and disk.

### 2. Core concept
- **One OS process per connection** (a "backend"), forked by the postmaster. Connections are expensive (several MB each, fork cost).
- **Background processes**: checkpointer, background writer, WAL writer, autovacuum launcher/workers, stats/IO workers.
- **Shared buffers**: PostgreSQL's page cache (8 KB pages), shared by all backends. The OS page cache sits underneath.
- **WAL**: changes are written to the write-ahead log first; data files are updated lazily. Commit = WAL flushed to disk.

### 3. Mental model
```text
client ──► backend process ──► shared_buffers (8 KB pages) ──► data files (eventually, by checkpointer/bgwriter)
                         └──► WAL buffers ──► pg_wal/ (flushed at COMMIT)
```

### 4. Delivery Plus mapping — **CURRENT**
- One server, nine databases, default configuration (no `postgresql.conf` overrides in the repo). Every service process holds a pool of up to 10 connections → up to ~90 backends for the nine DB-backed services.
- Data lives in the `postgres_data` volume (`docker-compose.base.yml`).

### 5. Example
```bash
dc exec postgres ps -o pid,cmd -A | grep postgres   # see the background processes and one per connection
```
```sql
SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname ORDER BY 2 DESC;
SHOW shared_buffers; SHOW max_connections;
```

### 6. Failure scenario
Running out of connections: `FATAL: sorry, too many clients already`. With 9 services × 2 replicas × 10 pool connections = 180 > 100 default `max_connections`.

### 7. Trade-offs
Process-per-connection gives isolation (a crash kills one backend) at the cost of expensive connections — the reason poolers like PgBouncer exist.

### 8. Performance
A query that fits in shared buffers is memory-speed; one that reads from disk can be 100× slower. `EXPLAIN (ANALYZE, BUFFERS)` shows `shared hit` vs `read`.

### 9. Security — every backend runs as the `postgres` OS user inside the container; database roles are a separate layer ([Book 04 Ch. 11](04-database-fundamentals.md#chapter-11--database-security-and-least-privilege)).
### 10. Operations — key gauges: active connections per database, buffer hit ratio, checkpoint frequency, WAL volume.

### 11. Lab
Run the commands above, then start `npm run e2e` and re-run the `pg_stat_activity` query while it runs.

### 12. Verification
You can name each background process and show which databases hold connections during the E2E run.

### 13. Interview questions
- *Beginner:* What is the WAL?
- *Intermediate:* Why are PostgreSQL connections expensive?
- *Advanced:* Shared buffers vs OS page cache — why both?
- *Senior:* How would you size `max_connections` and pools for this platform?

### 14. Senior discussion
One PostgreSQL instance for nine services: what are the noisy-neighbour risks, and what would you measure before splitting?

---

## Chapter 2 — MVCC, VACUUM, autovacuum and bloat

### 1. Why this exists
PostgreSQL never updates a row in place. Understanding that explains bloat, slow counts, and why long transactions are dangerous.

### 2. Core concept
- **MVCC**: every `UPDATE` writes a *new row version* (tuple) and marks the old one dead (with transaction IDs `xmin`/`xmax`). Readers see the version valid for their snapshot — readers never block writers.
- **VACUUM** reclaims dead tuples for reuse; **autovacuum** does it automatically based on thresholds.
- **Bloat**: dead space not yet reclaimed (or reclaimed but not returned to the OS).
- **Transaction ID wraparound**: IDs are 32-bit; vacuum must "freeze" old rows. Ignored, PostgreSQL eventually refuses writes.

### 3. Mental model
Every status change on an order is an insert of a new version plus a tombstone. A delivery that goes CREATED → DRIVER_ASSIGNED → PICKED_UP → IN_TRANSIT → DELIVERED leaves 4 dead versions behind.

### 4. Delivery Plus mapping — **CURRENT**
- Lifecycle tables are update-heavy: `orders.status` (up to ~8 transitions), `deliveries.status` (up to 5), `payments` (status + `publishedEventStatus`, `orderSyncedStatus`, `sideEffectsLeaseUntil` updates), `drivers.status` (toggles all day).
- `drivers` is the hottest: AVAILABLE ↔ BUSY for every delivery, and `updatedAt` changes each time.
- No vacuum tuning in the repo — defaults.

### 5. Example
```sql
-- in delivery_service
SELECT xmin, xmax, id, status FROM deliveries LIMIT 3;
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables;
```

### 6. Failure scenario
A long-running transaction (someone leaves `BEGIN;` open in `psql` during an incident) prevents vacuum from removing any dead tuples newer than its snapshot — across the whole database. Tables bloat, index scans slow down, and the problem persists until that session closes.

### 7. Trade-offs
MVCC gives non-blocking reads at the cost of write amplification and vacuum work. Systems with in-place updates (InnoDB uses undo logs) trade differently.

### 8. Performance
HOT (heap-only tuple) updates avoid index updates when no indexed column changes and the page has room. Updating `status` on `drivers` is not HOT if `status` is indexed — a reason to think twice before indexing very hot columns.

### 9. Security — dead tuples still contain old values (e.g. old addresses) until vacuumed and overwritten.
### 10. Operations — alert on `n_dead_tup` ratio, transactions open > N minutes, and `age(datfrozenxid)`.

### 11. Lab
[DB-11 Watch MVCC versions and vacuum](labs/database-labs.md#db-11-watch-mvcc-versions-and-vacuum).

### 12. Verification
After 10,000 status updates you see `n_dead_tup` rise, then fall after `VACUUM`, and `xmin` change on each update.

### 13. Interview questions
- *Beginner:* What does VACUUM do?
- *Intermediate:* Why do readers not block writers in PostgreSQL?
- *Advanced:* What is a HOT update?
- *Senior:* How does a forgotten open transaction cause an outage hours later?

### 14. Senior discussion
A future `driver_locations` history table would receive thousands of inserts per second and be queried by time range. Would you put it in PostgreSQL? With which index (see Chapter 3) and which retention strategy (partitioning + `DROP PARTITION`)?

---

## Chapter 3 — Index types: B-tree, GIN, GiST, BRIN, expression and partial

### 1. Why this exists
B-tree is the default, but some questions — "contains", "near", "overlaps", "in this time range of a huge append-only table" — need other structures.

### 2. Core concept
| Index | Good for | Delivery Plus relevance |
| --- | --- | --- |
| **B-tree** | equality, ranges, sorting | every current index — **CURRENT** |
| **Partial** | a subset of rows | `UQ_payments_active_order`, idempotency keys — **CURRENT** |
| **Expression** | `lower(email)`, computed values | case-insensitive email lookup — **FUTURE** |
| **GIN** | "contains" on arrays, JSONB, full-text, trigrams | restaurant search with `pg_trgm` — **FUTURE** |
| **GiST** | geometric/range data, nearest-neighbour (`<->`) | PostGIS geo search — **FUTURE** |
| **BRIN** | huge, naturally ordered tables (time series) | location/event history by time — **FUTURE** |
| **Hash** | equality only | rarely worth it |

### 3. Mental model
Pick the index by the *operator* in your `WHERE`, not by the column.

### 4. Delivery Plus mapping
- **CURRENT:** B-tree and partial unique indexes (see Book 04 Ch. 1 and 4).
- **Gap:** emails are unique on `credentials.email` as-is. `Alice@x.com` and `alice@x.com` are different rows unless the application lower-cases them. An expression unique index on `lower(email)` would make the rule database-enforced.

### 5. Example
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY idx_restaurants_name_trgm ON restaurants USING gin (name gin_trgm_ops);
-- now ILIKE '%piz%' can use the index
```

### 6. Failure scenario
`CREATE INDEX` (without `CONCURRENTLY`) on a busy table takes a lock that blocks all writes for the duration. `CONCURRENTLY` avoids that but can fail and leave an `INVALID` index you must drop.

### 7. Trade-offs
GIN: fast reads, slow updates (uses a pending list). GiST: flexible, lossy (rechecks rows). BRIN: tiny, only useful when physical order matches the query.

### 8. Performance — see the lab: trigram GIN turns a full scan of restaurants into an index lookup for substring search.
### 9. Security — none specific.
### 10. Operations — `SELECT indexrelid::regclass, idx_scan FROM pg_stat_user_indexes` to find unused indexes.

### 11. Lab
[DB-08 Trigram search vs ILIKE](labs/database-labs.md#db-08-trigram-search-vs-ilike).

### 12. Verification
`EXPLAIN ANALYZE … ILIKE '%piz%'` switches from `Seq Scan` to `Bitmap Index Scan on idx_restaurants_name_trgm`.

### 13. Interview questions
- *Beginner:* Name three PostgreSQL index types.
- *Intermediate:* When do you use GIN?
- *Advanced:* Why can BRIN be 1,000× smaller than a B-tree, and when is it useless?
- *Senior:* Full-text in PostgreSQL vs a search engine for restaurant search?

### 14. Senior discussion
Would you enforce case-insensitive email uniqueness with `citext`, an expression index, or application normalisation? What happens to existing duplicates?

---

## Chapter 4 — Data types and extensions that matter here

### 1. Why this exists
Wrong types cause silent bugs: floating-point money, timestamps without zones, random-looking IDs that fragment indexes.

### 2. Core concept
- `numeric(10,2)` for money (exact decimal) — never `float`.
- `timestamptz` (stored in UTC, displayed in the session zone) — not `timestamp` without zone.
- `uuid` (16 bytes) vs `bigint` (8 bytes, ordered).
- `ENUM` types for small fixed sets.
- `jsonb` for semi-structured data; arrays.
- Extensions: `pgcrypto`, `uuid-ossp`, `pg_trgm`, `postgis`, `pg_stat_statements`.

### 3. Mental model
A type is a constraint. `numeric(10,2)` says "money with cents, up to 99,999,999.99".

### 4. Delivery Plus mapping — **CURRENT**
- Money: `numeric(10,2)` for `orders."totalAmount"`, `order_items.price`, `payments.amount`, `menu_items.price`. TypeORM returns `numeric` as a **string**; code converts explicitly (`parseFloat(order.totalAmount)` when building events in `services/order-service/src/services/orders.service.ts`).
- Time: all `createdAt`/`updatedAt` are `TIMESTAMPTZ`.
- IDs: `uuid DEFAULT gen_random_uuid()`. The migrations run `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` for it; on PostgreSQL 13+ `gen_random_uuid()` is built in, so the extension is no longer required (harmless).
- Statuses: ENUM types per service.
- **NOT USED:** `jsonb`, arrays, `pg_trgm`, PostGIS, `pg_stat_statements`.

### 5. Example
```sql
SELECT 0.1::float8 + 0.2::float8;      -- 0.30000000000000004
SELECT 0.1::numeric + 0.2::numeric;    -- 0.3
```

### 6. Failure scenario
`parseFloat("19.99") * 3` in JavaScript = `59.97000000000001`. Summing money in floating point in the app layer (the cart total) accumulates errors; rounding at the end hides most of them, but money math is safest in integer cents or decimal libraries.

### 7. Trade-offs
UUID v4 keys are random → inserts land on random B-tree pages (more page splits, worse cache locality) compared with sequential IDs. UUID v7 (time-ordered) keeps uniqueness without the randomness penalty. At Delivery Plus scale this doesn't matter yet; at billions of rows it does.

### 8. Performance — `uuid` 16 B vs `bigint` 8 B per key, multiplied by every index that contains it.
### 9. Security — random IDs avoid enumeration (`/orders/1`, `/orders/2`), but ownership checks are still required.
### 10. Operations — enum changes need `ALTER TYPE … ADD VALUE` (cannot run inside a transaction block in some versions) — plan migrations accordingly.

### 11. Lab
Run the float vs numeric example; then `SELECT pg_typeof("totalAmount") FROM orders LIMIT 1;` and find the `parseFloat` calls in order-service.

### 12. Verification
You can explain why the event payload's `total` is a JavaScript number while the database stores a decimal string, and where precision could be lost.

### 13. Interview questions
- *Beginner:* Why not store money as float?
- *Intermediate:* `timestamp` vs `timestamptz`?
- *Advanced:* UUID v4 vs v7 vs bigint for primary keys?
- *Senior:* How should money be represented across DB, API JSON, events and the mobile client?

### 14. Senior discussion
Kafka events carry `total` as a JSON number (`OrderPayload` in `shared/src/events/order-events.ts`). Would you change it to a string or integer cents before external consumers (analytics, a real payment gateway) depend on it?

---

## Chapter 5 — The query planner and EXPLAIN ANALYZE

### 1. Why this exists
The planner decides how your SQL runs. When it guesses wrong, a 1 ms query becomes a 10 s query.

### 2. Core concept
- The planner estimates row counts from **statistics** (`ANALYZE`, `pg_stats`) and picks the cheapest plan by a **cost model**.
- Scan types: Seq Scan, Index Scan, Index Only Scan, Bitmap Index/Heap Scan.
- Join types: Nested Loop (small outer side), Hash Join (big unsorted sets), Merge Join (sorted inputs).
- `EXPLAIN` = estimated plan; `EXPLAIN ANALYZE` = runs it, shows actual rows and time; add `BUFFERS` for I/O.

### 3. Mental model
Compare **estimated rows** to **actual rows** at each node. Big mismatches mean bad statistics or correlated columns; that's where plans go wrong.

### 4. Delivery Plus mapping
Queries worth reading plans for — **CURRENT**:
- `GET /api/orders` → orders by `customerId` ordered by `createdAt` with offset (`services/order-service/src/repositories/orders.repository.ts`).
- `GET /api/notifications` → by `userId` ordered by `createdAt` (`services/notification-service/src/repositories/notifications.repository.ts`).
- Restaurant search `ILIKE` (`services/restaurant-service/src/repositories/restaurants.repository.ts`).
- Driver pick: `status = 'AVAILABLE' ORDER BY "updatedAt" DESC LIMIT 1` (`services/driver-service/src/repositories/drivers.repository.ts`).

### 5. Example
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM drivers WHERE status = 'AVAILABLE' ORDER BY "updatedAt" DESC LIMIT 1;
```
With a handful of drivers: Seq Scan + Sort (cheapest). With 100k drivers and an index on `(status, "updatedAt" DESC)`: Index Scan, stop after 1 row.

### 6. Failure scenario
Tiny dev data makes every plan a Seq Scan, so "it was fast locally". Always test plans with realistic volumes (the labs generate them).

### 7. Trade-offs — hints don't exist in core PostgreSQL by design; you influence plans with indexes, statistics (`ALTER TABLE … SET STATISTICS`, extended statistics) and query shape.
### 8. Performance — this chapter is performance.
### 9. Security — `EXPLAIN ANALYZE` executes the statement: never run it on an `UPDATE`/`DELETE` in production outside a transaction you roll back.
### 10. Operations — `auto_explain` logs plans of slow queries automatically; `pg_stat_statements` ranks queries by total time.

### 11. Lab
[DB-03 Index vs sequential scan](labs/database-labs.md#db-03-index-vs-sequential-scan) and [DB-12 Read a bad plan](labs/database-labs.md#db-12-read-a-bad-plan).

### 12. Verification
You identify the slowest node in a plan and fix it with one index, proving it with a second `EXPLAIN ANALYZE`.

### 13. Interview questions
- *Beginner:* What does EXPLAIN show?
- *Intermediate:* Nested loop vs hash join?
- *Advanced:* Why might PostgreSQL ignore your index?
- *Senior:* A query got 100× slower after a deploy with no code change. Walk through your investigation.

### 14. Senior discussion
Should application teams own their query plans (and review `EXPLAIN` output in PRs), or should a DBA function own them?

---

## Chapter 6 — Locks and transaction monitoring

### 1. Why this exists
Most PostgreSQL "outages" are lock queues: one statement waits, everything behind it waits.

### 2. Core concept
- **Row locks** (from `UPDATE`, `SELECT … FOR UPDATE`) block other writers to the same row, never readers.
- **Table locks**: `ACCESS SHARE` (any SELECT) … `ACCESS EXCLUSIVE` (most `ALTER TABLE`, `DROP`, non-concurrent index build). An `ACCESS EXCLUSIVE` request *queues* behind running queries and blocks every new query behind it.
- `pg_locks`, `pg_stat_activity` (`state`, `wait_event_type`, `query_start`, `xact_start`), `pg_blocking_pids(pid)`.

### 3. Mental model
```text
long SELECT (ACCESS SHARE)  ← running
ALTER TABLE (ACCESS EXCLUSIVE) ← waiting for the SELECT
every new SELECT ← waiting for the ALTER   ⇒ the table is effectively down
```

### 4. Delivery Plus mapping
- **CURRENT:** CAS updates take short row locks; no explicit `FOR UPDATE` in the codebase.
- **CURRENT risk:** migrations run at container start; a migration that needs `ACCESS EXCLUSIVE` on a hot table during a deploy can stall the service that's still running the old version.

### 5. Example
```sql
SELECT pid, state, wait_event_type, now() - xact_start AS tx_age, left(query, 60)
FROM pg_stat_activity WHERE datname = 'order_service' ORDER BY tx_age DESC NULLS LAST;

SELECT pid, pg_blocking_pids(pid) AS blocked_by, left(query, 60) FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

### 6. Failure scenario
`ALTER TABLE orders ADD COLUMN …` during peak traffic while an analyst runs a 10-minute report: checkout stops for 10 minutes.

### 7. Trade-offs — always set `lock_timeout` (e.g. `SET lock_timeout = '3s'`) in migrations so they fail fast and retry instead of freezing the table.
### 8. Performance — lock waits show up as latency with low CPU — a classic signature.
### 9. Security — `pg_terminate_backend` requires privileges; know who has them.
### 10. Operations — runbook: find the blocker with `pg_blocking_pids`, decide cancel (`pg_cancel_backend`) or terminate.

### 11. Lab
[DB-13 Lock queue behind ALTER TABLE](labs/database-labs.md#db-13-lock-queue-behind-alter-table).

### 12. Verification
You show a SELECT blocked behind an ALTER which is blocked behind an open transaction, and you release it.

### 13. Interview questions
- *Beginner:* Does a SELECT block an UPDATE in PostgreSQL?
- *Intermediate:* What does `lock_timeout` protect against?
- *Advanced:* Why can a fast DDL statement cause a long outage?
- *Senior:* Design a safe migration policy for this repository.

### 14. Senior discussion
Should migrations that take strong locks be forbidden in automatic deploys and require a scheduled window? How do you enforce that in CI?

---

## Chapter 7 — Connections, pooling and tuning basics

### 1. Why this exists
Default PostgreSQL settings are conservative; pool sizes are often guessed.

### 2. Core concept
- `max_connections` (default 100), `shared_buffers` (often ~25% of RAM), `work_mem` (per sort/hash *per operation*), `effective_cache_size` (planner hint), `maintenance_work_mem` (vacuum, index builds).
- Pools: application-side (TypeORM/pg) and server-side (PgBouncer).

### 3. Mental model
Throughput rises with concurrency up to roughly the number of CPU cores × a small factor, then falls. More connections than that just queue inside PostgreSQL instead of in the pool.

### 4. Delivery Plus mapping — **CURRENT**: defaults everywhere; `pg` pool default 10 per service process; no PgBouncer.

### 5. Example
`work_mem = 64MB` with 50 concurrent queries each doing 2 sorts can use 6.4 GB. "Per operation" is the trap.

### 6. Failure scenario
Raising `max_connections` to 1,000 to "fix" pool exhaustion; memory per backend × 1,000 exhausts RAM and the OOM killer takes PostgreSQL down.

### 7. Trade-offs — transaction pooling (PgBouncer) breaks session state; session pooling doesn't reduce server connections much.
### 8. Performance — measure with `pgbench` or a realistic load test before tuning ([Book 21](21-performance-engineering.md)).
### 9. Security — PgBouncer adds another place where credentials live.
### 10. Operations — tune via configuration management, never by hand on the server.

### 11. Lab
[DB-10 Exhaust the connection pool](labs/database-labs.md#db-10-exhaust-the-connection-pool).

### 12. Verification
You show requests queuing (latency up) while PostgreSQL CPU stays low, and explain why.

### 13. Interview questions
- *Beginner:* What is `max_connections`?
- *Intermediate:* Why is `work_mem` dangerous to raise?
- *Advanced:* When does PgBouncer help, and what breaks?
- *Senior:* Capacity plan PostgreSQL for 10× the current traffic.

### 14. Senior discussion
Managed PostgreSQL (RDS, Cloud SQL) hides most tuning. What does the team still own?

---

## Chapter 8 — Backups, restore and point-in-time recovery

### 1. Why this exists
Replication protects against hardware failure; only backups protect against *mistakes* (a bad migration, `DELETE` without `WHERE`), which replicate instantly.

### 2. Core concept
- **Logical backup** (`pg_dump`/`pg_restore`): portable, per database, slow for big data, point-in-time = when the dump ran.
- **Physical backup** (`pg_basebackup`) + **WAL archiving**: restore to any moment → **PITR**.
- Tools: pgBackRest, WAL-G, managed snapshots.

### 3. Mental model
Base backup = a photo; WAL archive = the video since the photo; PITR = play the video until just before the mistake.

### 4. Delivery Plus mapping
- **NOT IMPLEMENTED:** no backup scripts, no WAL archiving, no restore drill (issue #16). Redis and Kafka recovery boundaries are also undocumented.
- Recovery reality today: data lives in the `postgres_data` volume and nowhere else.

### 5. Example — a minimal per-service logical backup
```bash
for db in auth_service user_service restaurant_service menu_service order_service payment_service driver_service delivery_service notification_service; do
  dc exec -T postgres pg_dump -U postgres -d "$db" -Fc > "backup-$db.dump"
done
```

### 6. Failure scenario
Per-database dumps taken at slightly different times restore to an **inconsistent** cross-service state (an order exists, its payment doesn't). A physical backup of the whole server, or PITR to one timestamp, restores all nine databases to the same instant.

### 7. Trade-offs
| | Logical | Physical + PITR |
| --- | --- | --- |
| Granularity | per DB/table | whole cluster |
| Restore time | slow (rebuild indexes) | fast |
| Point in time | dump time | any second |
| Cross-version | yes | same major version |

### 8. Performance — dumps add read load; take them from a replica when one exists.
### 9. Security — encrypt backups at rest; they contain password hashes and personal data.
### 10. Operations — schedule, monitor success, test restores regularly, document RPO/RTO.

### 11. Lab
[OPS-07 Backup and restore one service database](labs/devops-labs.md#ops-07-backup-and-restore-one-service-database).

### 12. Verification
Restored row counts match; you can state the RPO of your procedure.

### 13. Interview questions
- *Beginner:* Why aren't replicas backups?
- *Intermediate:* What is PITR?
- *Advanced:* How do you restore a consistent state across nine databases?
- *Senior:* Define the backup strategy for Delivery Plus with RPO/RTO per service.

### 14. Senior discussion
Kafka retains events for 7 days. Could you rebuild a service's database by replaying events instead of restoring a backup? What would need to be true (see event sourcing in [Book 27](27-advanced-data-patterns.md))?

---

[Library index](README.md) · Previous: [Book 04](04-database-fundamentals.md) · Next: [Book 06 — Redis](06-redis.md)
