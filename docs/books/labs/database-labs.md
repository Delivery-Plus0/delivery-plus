# Database Labs (PostgreSQL)

[Lab index](README.md) · Books: [04 Database Fundamentals](../04-database-fundamentals.md), [05 PostgreSQL Deep Dive](../05-postgresql-deep-dive.md)

Set up the [lab environment](README.md#lab-environment) first. Labs that need bulk data create `lab_*` tables or tagged rows and clean them up at the end.

---

## DB-01 Constraints that save you

**Goal:** see a partial unique index stop a double payment that application code can't.

```sql
-- psql_db payment_service
BEGIN;
INSERT INTO payments ("orderId","customerId",amount,status)
VALUES ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000c1',10,'PENDING');
INSERT INTO payments ("orderId","customerId",amount,status)
VALUES ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000c1',10,'PENDING');
ROLLBACK;

BEGIN;
INSERT INTO payments ("orderId","customerId",amount,status)
VALUES ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000c1',10,'PENDING');
INSERT INTO payments ("orderId","customerId",amount,status)
VALUES ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-0000000000c1',10,'FAILED');
SELECT status FROM payments WHERE "orderId" = '00000000-0000-4000-8000-0000000000a1';
ROLLBACK;
\d payments
```
**Expected:** the second PENDING insert fails with `duplicate key value violates unique constraint "UQ_payments_active_order"`; the FAILED row is accepted (the index covers only PENDING/PROCESSING/COMPLETED). `\d payments` shows the `WHERE` clause.
**Why:** a partial unique index enforces "one *active* payment per order" while allowing retries after a decline. It is the backstop behind `createPayment`'s fast-path check.
**Links:** [Book 04 Ch. 1](../04-database-fundamentals.md#chapter-1--tables-keys-and-constraints), [Book 25 Ch. 2](../25-payment-systems.md#chapter-2--idempotency-duplicates-and-concurrency-in-payments).

---

## DB-02 Joins, aggregates and NULLs on real orders

**Goal:** answer operational questions with SQL. Run `npm run seed` and `npm run e2e` (or `place_order`/`deliver_order` a few times) first.

```sql
-- psql_db order_service
-- 1. orders per status
SELECT status, count(*) FROM orders GROUP BY status ORDER BY 2 DESC;

-- 2. snapshot check: does every order's total equal its lines?
SELECT o.id, o."totalAmount", SUM(oi.price * oi.quantity) AS lines_total
FROM orders o JOIN order_items oi ON oi."orderId" = o.id
GROUP BY o.id HAVING o."totalAmount" <> SUM(oi.price * oi.quantity);

-- 3. orders without items (should be none)
SELECT o.id FROM orders o LEFT JOIN order_items oi ON oi."orderId" = o.id WHERE oi.id IS NULL;

-- 4. the most ordered items by name
SELECT name, SUM(quantity) AS qty FROM order_items GROUP BY name ORDER BY qty DESC LIMIT 5;
```
```sql
-- psql_db delivery_service — NULL semantics
SELECT count(*) FROM deliveries WHERE "driverId" = NULL;   -- always 0
SELECT count(*) FROM deliveries WHERE "driverId" IS NULL;  -- deliveries waiting for a driver
```
**Expected:** query 2 and 3 return no rows; the two NULL queries differ whenever an unassigned delivery exists.
**Why:** `NULL = NULL` is unknown, not true; aggregates with `HAVING` filter groups after grouping.
**Links:** [Book 04 Ch. 3](../04-database-fundamentals.md#chapter-3--querying-joins-subqueries-ctes-views-aggregates-null).

---

## DB-03 Index vs sequential scan

**Goal:** watch the planner switch strategies when an index matches the query.

```sql
-- psql_db notification_service
INSERT INTO notifications ("userId", type, title, message, "createdAt")
SELECT CASE WHEN g % 100 = 0 THEN '11111111-1111-4111-8111-111111111111'::uuid ELSE gen_random_uuid() END,
       'ORDER_CONFIRMED', 'lab', 'lab row ' || g, now() - g * interval '1 second'
FROM generate_series(1, 200000) g;
ANALYZE notifications;

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM notifications WHERE "userId" = '11111111-1111-4111-8111-111111111111'
ORDER BY "createdAt" DESC LIMIT 20;

CREATE INDEX CONCURRENTLY lab_notifications_user_created ON notifications ("userId", "createdAt" DESC);

EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM notifications WHERE "userId" = '11111111-1111-4111-8111-111111111111'
ORDER BY "createdAt" DESC LIMIT 20;
```
**Expected:** before — `Index Scan using "IDX_notifications_userId"` (or a bitmap scan) **plus a Sort** of ~2,000 rows; after — an index scan on `lab_notifications_user_created` with **no Sort node**, reading ~20 rows. Compare `Execution Time`.
**Variant (drivers):** in `driver_service`, insert 100k `lab` drivers and `EXPLAIN` the dispatch query `SELECT * FROM drivers WHERE status='AVAILABLE' ORDER BY "updatedAt" DESC LIMIT 1;` before and after `CREATE INDEX lab_drivers_status_updated ON drivers (status, "updatedAt" DESC);` (insert with unique `userId` = `gen_random_uuid()`, `"licensePlate"` = `'LAB'`).
**Cleanup:**
```sql
DROP INDEX CONCURRENTLY lab_notifications_user_created;
DELETE FROM notifications WHERE title = 'lab';
```
**Links:** [Book 04 Ch. 4](../04-database-fundamentals.md#chapter-4--indexes-single-composite-covering-partial), [Book 05 Ch. 5](../05-postgresql-deep-dive.md#chapter-5--the-query-planner-and-explain-analyze).

---

## DB-04 Read phenomena in two psql sessions

**Goal:** reproduce a non-repeatable read and make it disappear.

Setup (once): `psql_db order_service` → `CREATE TABLE lab_orders AS SELECT id, status FROM orders LIMIT 5;` → note one `id`.

| Session A | Session B |
| --- | --- |
| `BEGIN;` | |
| `SELECT status FROM lab_orders WHERE id = '<id>';` | |
| | `UPDATE lab_orders SET status = 'CANCELLED' WHERE id = '<id>';` |
| `SELECT status FROM lab_orders WHERE id = '<id>';` → changed | |
| `COMMIT;` | |

Repeat with `BEGIN ISOLATION LEVEL REPEATABLE READ;` in session A (reset the row first).
**Expected:** Read Committed → the second SELECT sees B's update; Repeatable Read → it still sees the old value.
**Cleanup:** `DROP TABLE lab_orders;` (after DB-05, DB-11 and DB-13 if you do them next).
**Links:** [Book 04 Ch. 5](../04-database-fundamentals.md#chapter-5--transactions-acid-and-isolation).

---

## DB-05 Lost update vs compare-and-set

**Goal:** understand why order status writes use `WHERE status = :from`.

Setup: `CREATE TABLE lab_counter (id int PRIMARY KEY, n int); INSERT INTO lab_counter VALUES (1, 0), (2, 0);`

**Lost update (read-modify-write in the "application"):**
| Session A | Session B |
| --- | --- |
| `SELECT n FROM lab_counter WHERE id=1;` → 0 | `SELECT n FROM lab_counter WHERE id=1;` → 0 |
| `UPDATE lab_counter SET n = 1 WHERE id=1;` (app computed 0+1) | |
| | `UPDATE lab_counter SET n = 1 WHERE id=1;` (app computed 0+1) |
Result: `n = 1` after two increments.

**Compare-and-set (the order-service pattern):** with `lab_orders` from DB-04 set to `'PAYMENT_PENDING'` for one id, run in both sessions:
```sql
UPDATE lab_orders SET status = 'CONFIRMED' WHERE id = '<id>' AND status = 'PAYMENT_PENDING';
```
**Expected:** one session prints `UPDATE 1`, the other `UPDATE 0`. In `services/order-service/src/repositories/orders.repository.ts`, `updateStatus` returns `null` for the `UPDATE 0` writer, and `OrdersService.updateStatus` re-reads and publishes **nothing** if the order is already at the target — that's why "Order Confirmed" is published once.
**Links:** [Book 04 Ch. 6](../04-database-fundamentals.md#chapter-6--concurrency-control-locks-cas-lost-updates-and-deadlocks), [case study 06](../case-studies/06-in-memory-idempotency.md).

---

## DB-06 Offset vs keyset pagination

**Goal:** measure deep-page cost. Reuse the DB-03 data (before cleanup) with the composite index in place.

```sql
-- offset: a deep page across all notifications (~200k rows from DB-03)
EXPLAIN ANALYZE SELECT * FROM notifications ORDER BY "createdAt" DESC, id DESC OFFSET 180000 LIMIT 20;

-- keyset: continue after a bookmark
SELECT "createdAt", id FROM notifications ORDER BY "createdAt" DESC, id DESC OFFSET 179999 LIMIT 1;  -- take the bookmark
CREATE INDEX CONCURRENTLY lab_notifications_created_id ON notifications ("createdAt" DESC, id DESC);
EXPLAIN ANALYZE SELECT * FROM notifications
WHERE ("createdAt", id) < ('<createdAt>', '<id>')
ORDER BY "createdAt" DESC, id DESC LIMIT 20;
```
**Expected:** the OFFSET query reads ~180,020 rows; the keyset query reads ~20 through the index. The time gap grows with depth.
**Cleanup:** `DROP INDEX CONCURRENTLY lab_notifications_created_id;` then the DB-03 cleanup.
**Links:** [Book 04 Ch. 10](../04-database-fundamentals.md#chapter-10--pagination-strategies), [Book 03 Ch. 4](../03-http-apis-and-web.md#chapter-4--idempotency-keys-pagination-filtering-sorting-and-search).

---

## DB-07 Make a deadlock

Using `lab_counter` from DB-05:
| Session A | Session B |
| --- | --- |
| `BEGIN; UPDATE lab_counter SET n = n + 1 WHERE id = 1;` | `BEGIN; UPDATE lab_counter SET n = n + 1 WHERE id = 2;` |
| `UPDATE lab_counter SET n = n + 1 WHERE id = 2;` (waits) | |
| | `UPDATE lab_counter SET n = n + 1 WHERE id = 1;` |

**Expected:** within ~1 s (`deadlock_timeout`) one session gets `ERROR: deadlock detected`; the other proceeds. `COMMIT`/`ROLLBACK` both.
**Why:** opposite lock order. The fix is a consistent order (e.g. always lock rows by ascending id) or avoiding multi-row locks (CAS on one row, as Delivery Plus does).
**Cleanup:** `DROP TABLE lab_counter;`
**Links:** [Book 04 Ch. 6](../04-database-fundamentals.md#chapter-6--concurrency-control-locks-cas-lost-updates-and-deadlocks).

---

## DB-08 Trigram search vs ILIKE

**Goal:** make substring restaurant search index-backed.

```sql
-- psql_db restaurant_service
CREATE TABLE lab_restaurants AS
SELECT gen_random_uuid() AS id, 'Restaurant ' || md5(g::text) || CASE WHEN g % 1000 = 0 THEN ' Pizza' ELSE '' END AS name
FROM generate_series(1, 200000) g;
ANALYZE lab_restaurants;
EXPLAIN ANALYZE SELECT * FROM lab_restaurants WHERE name ILIKE '%pizza%' LIMIT 20;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX lab_restaurants_name_trgm ON lab_restaurants USING gin (name gin_trgm_ops);
EXPLAIN ANALYZE SELECT * FROM lab_restaurants WHERE name ILIKE '%pizza%' LIMIT 20;
```
**Expected:** `Seq Scan` first, then `Bitmap Index Scan on lab_restaurants_name_trgm`.
**Why:** this is the query shape of `services/restaurant-service/src/repositories/restaurants.repository.ts` (`name ILIKE :search`); a B-tree can't serve a leading wildcard, a trigram GIN index can.
**Cleanup:** `DROP TABLE lab_restaurants;` (leave the extension or `DROP EXTENSION pg_trgm;`).
**Links:** [Book 05 Ch. 3](../05-postgresql-deep-dive.md#chapter-3--index-types-b-tree-gin-gist-brin-expression-and-partial).

---

## DB-09 Write and run a migration

**Goal:** add an index through the real migration mechanism, safely.

1. On a scratch branch create `services/notification-service/src/database/migrations/003-lab-notifications-user-created.ts`:
```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class LabNotificationsUserCreated1700000000003 implements MigrationInterface {
  name = 'LabNotificationsUserCreated1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_notifications_user_created" ON "notifications" ("userId", "createdAt" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notifications_user_created"`);
  }
}
```
2. `dc up -d --build notification-service` — the container runs pending migrations at start (`Dockerfile` `CMD`: `typeorm migration:run -d …/data-source.js`).
3. `psql_db notification_service` → `SELECT name FROM migrations ORDER BY id;` and `\di notifications*`.
4. Revert the branch and rebuild: the old code still runs against the new schema (an additive change).

**Expected:** the migration is listed, the index exists, the service is healthy.
**Why:** expand-style migrations are backward compatible.
**The production catch — try it:** on a large table you'd want `CREATE INDEX CONCURRENTLY` (no write lock), which PostgreSQL refuses inside a transaction block. The migration CLI here runs in TypeORM's default `migrationsTransactionMode: 'all'` (all pending migrations in one transaction), and in that mode TypeORM **rejects** a migration that sets `transaction = false` (`ForbiddenTransactionModeOverrideError`). Add `CONCURRENTLY` and `transaction = false` to your migration, rebuild, and read the failing container log. Supporting online index builds means changing the runner to `'each'` mode (or `-t each` on the CLI) — a deliberate change to how every service migrates.
**Cleanup:** `DROP INDEX "IDX_notifications_user_created"; DELETE FROM migrations WHERE name = 'LabNotificationsUserCreated1700000000003';`
**Links:** [Book 04 Ch. 8](../04-database-fundamentals.md#chapter-8--migrations-schema-evolution-and-zero-downtime-changes), [Book 18 Ch. 5](../18-cicd-and-devops.md#chapter-5--migrations-release-safety-and-rollback).

---

## DB-10 Exhaust the connection pool

**Goal:** see what happens when PostgreSQL runs out of connections.

```bash
psql_db postgres -c "SHOW max_connections;" ; psql_db postgres -c "SELECT datname, count(*) FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC;"
# hold ~90 idle connections for 2 minutes (inside the postgres container)
dc exec -d postgres sh -c 'for i in $(seq 1 90); do psql -U postgres -d postgres -c "select pg_sleep(120)" & done; wait'
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $CUSTOMER" $API/api/orders
dc logs --since 1m order-service | grep -i "too many clients\|remaining connection" | head
```
**Expected:** with the server full, services that need a *new* connection fail with `sorry, too many clients already` (existing pooled connections may still work, so results vary by service). After 2 minutes everything recovers.
**Why:** total connections = services × pool size + tools. Application pools (10 per service by default) and `max_connections` (100) must be sized together; PgBouncer exists for this problem.
**Links:** [Book 04 Ch. 9](../04-database-fundamentals.md#chapter-9--connection-pooling-query-plans-slow-queries-and-n1), [Book 05 Ch. 7](../05-postgresql-deep-dive.md#chapter-7--connections-pooling-and-tuning-basics).

---

## DB-11 Watch MVCC versions and vacuum

```sql
-- psql_db order_service  (uses lab_orders from DB-04)
SELECT xmin, xmax, id, status FROM lab_orders LIMIT 2;
UPDATE lab_orders SET status = status;                 -- rewrite every row
SELECT xmin, id FROM lab_orders LIMIT 2;               -- new xmin: new row versions
DO $$ BEGIN FOR i IN 1..2000 LOOP UPDATE lab_orders SET status = status; END LOOP; END $$;
SELECT n_live_tup, n_dead_tup, last_autovacuum FROM pg_stat_user_tables WHERE relname = 'lab_orders';
VACUUM (VERBOSE) lab_orders;
SELECT n_live_tup, n_dead_tup FROM pg_stat_user_tables WHERE relname = 'lab_orders';
```
**Expected:** `xmin` changes on every update; `n_dead_tup` climbs into the thousands, then drops after `VACUUM`.
**Why:** PostgreSQL writes a new row version per update; lifecycle tables (orders, deliveries, drivers) accumulate dead tuples for vacuum to reclaim.
**Links:** [Book 05 Ch. 2](../05-postgresql-deep-dive.md#chapter-2--mvcc-vacuum-autovacuum-and-bloat).

---

## DB-12 Read a bad plan

**Goal:** diagnose a slow query from its plan alone.

```sql
-- psql_db driver_service
CREATE TABLE lab_drivers AS
SELECT gen_random_uuid() AS id, (ARRAY['OFFLINE','AVAILABLE','BUSY'])[1 + (g % 3)] AS status,
       now() - (g || ' seconds')::interval AS "updatedAt"
FROM generate_series(1, 300000) g;
ANALYZE lab_drivers;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM lab_drivers WHERE status = 'AVAILABLE' ORDER BY "updatedAt" DESC LIMIT 1;
CREATE INDEX lab_drivers_status_updated ON lab_drivers (status, "updatedAt" DESC);
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM lab_drivers WHERE status = 'AVAILABLE' ORDER BY "updatedAt" DESC LIMIT 1;
```
**Expected:** first plan: `Seq Scan` + `Sort` (or top-N heapsort) over ~100k matching rows; second: `Index Scan … Limit` touching a few buffers.
**Read the plan:** find the node with the largest `actual time`; compare `rows` estimated vs actual; note `Buffers: shared read` vs `hit`.
**Cleanup:** `DROP TABLE lab_drivers;`
**Links:** [Book 05 Ch. 5](../05-postgresql-deep-dive.md#chapter-5--the-query-planner-and-explain-analyze), [Book 21 Ch. 6](../21-performance-engineering.md#chapter-6--applying-it-the-hot-paths-of-delivery-plus).

---

## DB-13 Lock queue behind ALTER TABLE

Three sessions on `lab_orders` (DB-04):
| A | B | C |
| --- | --- | --- |
| `BEGIN; SELECT * FROM lab_orders LIMIT 1;` (keep open) | | |
| | `ALTER TABLE lab_orders ADD COLUMN lab_note text;` (waits) | |
| | | `SELECT count(*) FROM lab_orders;` (waits!) |

In a fourth session:
```sql
SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event_type, left(query, 50)
FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0;
```
Then `COMMIT;` in A.
**Expected:** C waits behind B, which waits behind A — a plain SELECT is blocked by a DDL statement that hasn't even started. After A commits, B then C complete.
**Why:** `ALTER TABLE` needs `ACCESS EXCLUSIVE`; queued lock requests block later compatible ones. Use `SET lock_timeout = '3s'` in migrations.
**Cleanup:** `DROP TABLE lab_orders;`
**Links:** [Book 05 Ch. 6](../05-postgresql-deep-dive.md#chapter-6--locks-and-transaction-monitoring).

---

[Lab index](README.md)
