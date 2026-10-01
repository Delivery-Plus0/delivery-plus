# Book 04 — Database Fundamentals

[Library index](README.md) · Previous: [Book 03](03-http-apis-and-web.md) · Next: [Book 05 — PostgreSQL Deep Dive](05-postgresql-deep-dive.md)

**Level:** Junior → Advanced · **Prerequisites:** basic SQL (`SELECT … WHERE …`).

Delivery Plus keeps its durable truth in **nine PostgreSQL databases**, one per service, on one PostgreSQL 16 server (`docker/postgres/init.sql`): `auth_service`, `user_service`, `restaurant_service`, `menu_service`, `order_service`, `payment_service`, `driver_service`, `delivery_service`, `notification_service`. Schemas are created by TypeORM migrations in `services/<name>/src/database/migrations/`.

**Open a SQL shell for any lab in this book:**
```bash
alias dc='docker compose -f docker-compose.base.yml -f docker-compose.dev.yml'
dc exec postgres psql -U postgres -d order_service
```

**Labs:** [database-labs.md](labs/database-labs.md).

---

## Chapter 1 — Tables, keys and constraints

### 1. Why this exists
A database is not just storage; it is the last line of defence for **invariants** — facts that must always be true no matter how many bugs the application has.

### 2. Core concept
- **Table / row / column**: a relation, a tuple, a typed attribute.
- **Primary key**: uniquely identifies a row; never changes.
- **Foreign key**: a column that must match a primary key in another table (referential integrity).
- **Unique constraint / unique index**: no two rows share the value(s).
- **Check constraint**: an arbitrary boolean rule (`CHECK (quantity > 0)`).
- **NOT NULL**, **DEFAULT**, **enum types**.

### 3. Mental model
Application code says "this *should* not happen". A constraint says "this *cannot* happen". Under concurrency, only the second one is true.

### 4. Delivery Plus mapping — **CURRENT**
| Invariant | How it is enforced | File |
| --- | --- | --- |
| One credential per email | `UQ_credentials_email` | `services/auth-service/src/database/migrations/001-initial-schema.ts` |
| One delivery per order | `UQ_deliveries_orderId` | `services/delivery-service/src/database/migrations/001-initial-schema.ts` |
| One driver profile per user | `UQ_drivers_userId` | `services/driver-service/src/database/migrations/001-initial-schema.ts` |
| At most one *active* payment per order | partial unique `UQ_payments_active_order … WHERE status IN ('PENDING','PROCESSING','COMPLETED')` | `services/payment-service/src/database/migrations/001-initial-schema.ts` |
| Idempotency key unique per customer | partial unique `… ("customerId","idempotencyKey") WHERE "idempotencyKey" IS NOT NULL` | orders and payments migrations |
| Order items belong to an existing order | FK `FK_order_items_order … ON DELETE CASCADE` | order-service migration |
| Status is one of a fixed set | PostgreSQL `ENUM` types (`order_status`, `delivery_status`, …) | each migration |
| IDs | `uuid DEFAULT gen_random_uuid()` | all services (`002-uuid-primary-key-defaults.ts`) |

Notice what is **missing**:
- **No cross-service foreign keys.** `deliveries.orderId` refers to an order in *another database*. PostgreSQL cannot enforce it; the service checks it by calling order-service (`DeliveriesService.create` → `orderClient.getOrder`). That is the price of database-per-service ([Book 10](10-microservices-and-domain-design.md)).
- **No check constraints** on quantities or prices (`order_items.quantity`, `menu_items.price`). Validation lives only in DTOs (`@Min(1)`, `@IsPositive()`). A bug or a manual SQL fix can still write `quantity = -3`.

### 5. Example
```sql
-- would make the quantity invariant real
ALTER TABLE order_items ADD CONSTRAINT chk_order_items_quantity_positive CHECK (quantity > 0);
```

### 6. Failure scenario
Two concurrent `POST /api/payments` for the same order. Both application checks (`findActiveByOrder` → none) pass at the same instant. Without `UQ_payments_active_order`, both insert → two active payments → double charge. With it, the second insert fails with a unique violation, which payment-service turns into a conflict. See [Book 25](25-payment-systems.md).

### 7. Trade-offs
Constraints make bugs loud (an error) instead of silent (bad data). They also make some migrations harder (adding a constraint to a table with bad rows fails). Enum types are compact and safe but adding a value needs a migration; a `varchar` + check constraint is easier to evolve.

### 8. Performance
Unique constraints are indexes: they speed up lookups on those columns and cost a little on every write.

### 9. Security
Constraints protect against application bugs *and* against injected writes. They don't protect against a superuser — see Chapter 11 on least privilege.

### 10. Operations
Unique-violation errors (`23505`) in logs are often *expected* (idempotency, races). Classify them; don't alert on them blindly.

### 11. Lab
[DB-01 Constraints that save you](labs/database-labs.md#db-01-constraints-that-save-you) — try to insert two active payments for the same order.

### 12. Verification
The second insert fails with `duplicate key value violates unique constraint "UQ_payments_active_order"`, and an insert with `status = 'FAILED'` succeeds.

### 13. Interview questions
- *Beginner:* Primary key vs unique constraint?
- *Intermediate:* What is a partial unique index? Give the Delivery Plus example.
- *Advanced:* Why can't `deliveries.orderId` have a foreign key?
- *Senior:* Which invariants belong in the database, and which in code?

### 14. Senior discussion
Without cross-service foreign keys, orphans are possible (a delivery for an order that was deleted). How would you detect them, and do you care?

---

## Chapter 2 — Normalization and deliberate denormalization

### 1. Why this exists
Storing the same fact in two places means two places to update — and eventually they disagree.

### 2. Core concept
- **1NF**: atomic values, no repeating groups (no `items = "burger,fries"` column).
- **2NF**: every non-key column depends on the *whole* key.
- **3NF**: non-key columns depend *only* on the key (no "transitive" facts like storing the restaurant's name on every order row).
- **Denormalization**: deliberately duplicating data for performance, history, or service independence.

### 3. Mental model
Normalize facts that **change**; snapshot facts that must be **frozen in time**.

### 4. Delivery Plus mapping — **CURRENT**
- `order_items` copies `name` and `price` from the menu at checkout (`services/order-service/src/entities/order-item.entity.ts`). That is *not* a normalization mistake: an order must keep the price the customer paid even if the menu changes tomorrow. It is a **snapshot**.
- `payments.customerId` duplicates `orders.customerId` — needed because payment-service cannot join to another service's database, and because it authorizes `GET /payments/:id` locally.
- `orders.totalAmount` is derivable from `order_items` but stored — a snapshot of what was charged.
- `user_profiles.email` duplicates `credentials.email` across two services (auth and user) — a known synchronization risk if email change is ever added.
- **Delivery address snapshot (CURRENT, issue #95):** orders copy the drop-off address at checkout (`deliveryAddress`, `deliveryNotes`, optional coordinates), from the request or else from the mutable profile, so later profile edits don't move a placed order.

### 5. Example
```sql
-- 3NF would compute totals instead of storing them:
SELECT o.id, SUM(oi.price * oi.quantity) AS computed_total, o."totalAmount"
FROM orders o JOIN order_items oi ON oi."orderId" = o.id
GROUP BY o.id;
```
If `computed_total <> "totalAmount"` for any row, the snapshot and the lines disagree — a data-quality check you can run.

### 6. Failure scenario
Cart prices are copied when an item is added (`services/cart-service/src/services/cart.service.ts`) and never re-checked at checkout. If the restaurant raises a price in between, the order is created at the old price. Snapshotting too *early* is a bug (issue #42).

### 7. Trade-offs
| | Normalized | Denormalized |
| --- | --- | --- |
| Writes | one place | many places |
| Reads | joins | direct |
| History | must be modelled separately | natural snapshot |
| Cross-service | impossible (no joins across DBs) | required |

### 8. Performance
Joins on indexed keys are cheap at this scale; denormalize for *independence* and *history* before you denormalize for speed.

### 9. Security
Every copy of personal data (email, address) is another place to protect and to erase on deletion requests.

### 10. Operations
Duplicated data needs a reconciliation job or an event that keeps copies in sync; neither exists for `email` today.

### 11. Lab
[DB-02 Joins, aggregates and NULLs on real orders](labs/database-labs.md#db-02-joins-aggregates-and-nulls-on-real-orders) includes the total-vs-lines check above.

### 12. Verification
Your query returns zero mismatched orders, and you can explain how a mismatch could ever arise.

### 13. Interview questions
- *Beginner:* What is 1NF?
- *Intermediate:* Why does `order_items` store `price`?
- *Advanced:* When is denormalization a correctness requirement rather than an optimisation?
- *Senior:* How do you keep a duplicated field consistent across two services?

### 14. Senior discussion
Should the order store a snapshot of the restaurant (name, address) too? What would the restaurant dashboard and the driver app need?

---

## Chapter 3 — Querying: joins, subqueries, CTEs, views, aggregates, NULL

### 1. Why this exists
You will debug production by querying it. Fluency in SQL is not optional for backend engineers.

### 2. Core concept
- **INNER JOIN** (matching rows only), **LEFT JOIN** (all left rows, NULLs where no match), **RIGHT/FULL** (rarely needed).
- **Subquery** and **CTE** (`WITH x AS (…)`) to structure logic.
- **View**: a named query. **Materialized view**: a stored result you refresh.
- **Aggregates**: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX` with `GROUP BY`; filter groups with `HAVING`.
- **NULL** means *unknown*: `NULL = NULL` is not true; use `IS NULL`. `COUNT(col)` skips NULLs; `COUNT(*)` doesn't.

### 3. Mental model
SQL is declarative: describe the result, the planner chooses how. Read a query bottom-up: `FROM/JOIN` → `WHERE` → `GROUP BY` → `HAVING` → `SELECT` → `ORDER BY` → `LIMIT`.

### 4. Delivery Plus mapping
- All application queries go through TypeORM repositories; raw SQL is used in migrations and in `services/payment-service/src/repositories/payments.repository.ts` (`now() + (:ttlMs * interval '1 millisecond')` for the lease).
- Joins happen only *within* a service database: `orders` ⨝ `order_items` (eager relation, `services/order-service/src/entities/order.entity.ts`); `categories` and `menu_items` in menu-service.
- **NOT USED:** views and materialized views. A natural future use: a restaurant dashboard "orders per hour" read model ([Book 27](27-advanced-data-patterns.md)).

### 5. Example
```sql
-- orders per status in the last 24h, only statuses with more than 2 orders
SELECT status, COUNT(*) AS n
FROM orders
WHERE "createdAt" > now() - interval '24 hours'
GROUP BY status
HAVING COUNT(*) > 2
ORDER BY n DESC;

-- deliveries still waiting for a driver (run in delivery_service)
SELECT id, "orderId", "createdAt" FROM deliveries WHERE "driverId" IS NULL AND status = 'CREATED';
```

### 6. Failure scenario
`WHERE "driverId" = NULL` returns nothing, always. The bug looks like "no deliveries are waiting" during an incident.

### 7. Trade-offs
ORMs are productive and safe against injection; raw SQL is precise for complex queries. TypeORM's eager relations always load items — convenient for one order, wasteful for a list of 100 orders where you only show totals.

### 8. Performance
`COUNT(*)` on a big table is a full scan in PostgreSQL (MVCC has no cached row count). Materialized views trade freshness for read speed.

### 9. Security
Never build SQL with string concatenation from input. TypeORM parameters (`:search`) are safe; `ILIKE '%${input}%'` built by hand is not.

### 10. Operations
Ad-hoc production queries must be read-only, time-limited (`SET statement_timeout = '5s'`), and run against a replica when one exists.

### 11. Lab
[DB-02 Joins, aggregates and NULLs on real orders](labs/database-labs.md#db-02-joins-aggregates-and-nulls-on-real-orders).

### 12. Verification
You can answer "how many orders failed payment today?" and "which orders have no items?" with one query each.

### 13. Interview questions
- *Beginner:* INNER vs LEFT JOIN?
- *Intermediate:* WHERE vs HAVING?
- *Advanced:* Why is `COUNT(*)` slow on large PostgreSQL tables?
- *Senior:* How do you give analysts SQL access without hurting production?

### 14. Senior discussion
Cross-service questions ("orders whose delivery took more than 45 minutes") cannot be answered with one SQL query in this architecture. Where should that data come from?

---

## Chapter 4 — Indexes: single, composite, covering, partial

### 1. Why this exists
Without an index, every lookup reads the whole table.

### 2. Core concept
- **B-tree index** (default): sorted keys → row locations. Supports `=`, `<`, `>`, `BETWEEN`, prefix `LIKE 'abc%'`, `ORDER BY`.
- **Composite index** `(a, b)`: sorted by `a`, then `b`. Usable for `a`, or `a and b`, **not** for `b` alone (leftmost-prefix rule).
- **Covering index**: contains all columns a query needs → *index-only scan* (`INCLUDE (...)` in PostgreSQL).
- **Partial index**: only rows matching a `WHERE` — smaller, and can enforce conditional uniqueness.

### 3. Mental model
An index is a phone book sorted by (last name, first name). Finding "Smith, John" is fast; finding everyone named "John" is not.

### 4. Delivery Plus mapping — **CURRENT**
- Single-column: `IDX_orders_customerId`, `IDX_orders_restaurantId`, `IDX_menu_items_restaurantId`, `IDX_notifications_userId`, `IDX_deliveries_driverId`, `IDX_restaurants_ownerId`.
- Partial unique: payments and idempotency keys (Chapter 1).
- **Gap:** `GET /api/notifications` sorts a user's notifications by `createdAt DESC` (`services/notification-service/src/repositories/notifications.repository.ts`) with only `IDX_notifications_userId`. A composite `("userId", "createdAt" DESC)` returns the page pre-sorted.
- **Gap:** the driver pick query filters `status = 'AVAILABLE'` and sorts by `updatedAt DESC`; there is no index on `drivers.status`.

### 5. Example
```sql
CREATE INDEX CONCURRENTLY idx_notifications_user_created
  ON notifications ("userId", "createdAt" DESC);
```

### 6. Failure scenario
Adding indexes "just in case" on a write-heavy table (e.g. a future driver-location history) — every insert updates every index; write throughput collapses.

### 7. Trade-offs
Each index: faster reads on matching queries, slower writes, more disk and memory, longer vacuum.

### 8. Performance
With the composite index, "page 1 of a user's notifications" reads ~`limit` index entries instead of all the user's rows plus a sort.

### 9. Security — not a primary concern; but missing indexes on auth lookups make brute-force attacks more expensive for *you*.
### 10. Operations — build big indexes `CONCURRENTLY` (no write lock) and watch for invalid indexes if the build fails ([Book 05](05-postgresql-deep-dive.md)).

### 11. Lab
[DB-03 Index vs sequential scan](labs/database-labs.md#db-03-index-vs-sequential-scan).

### 12. Verification
Before: `Seq Scan` + `Sort`. After: `Index Scan` without a separate sort, and lower execution time.

### 13. Interview questions
- *Beginner:* What does an index cost?
- *Intermediate:* Explain the leftmost-prefix rule.
- *Advanced:* What is an index-only scan, and why might it still visit the heap?
- *Senior:* How do you find unused indexes in production?

### 14. Senior discussion
Should `deliveries` have a composite index on `("driverId", status)` for the planned "driver's current delivery" endpoint (issue #96)? What query would it serve, and how selective is it?

---

## Chapter 5 — Transactions, ACID and isolation

### 1. Why this exists
Several writes must succeed or fail together, and concurrent requests must not see each other's half-finished work.

### 2. Core concept
**ACID**:
- **Atomicity** — all or nothing.
- **Consistency** — constraints hold before and after.
- **Isolation** — concurrent transactions don't see each other's partial state (to a degree set by the isolation level).
- **Durability** — once committed, it survives a crash (the WAL).

**Isolation levels** (weakest → strongest) and the anomalies they allow:

| Level | Dirty read | Non-repeatable read | Phantom | Lost update / write skew |
| --- | --- | --- | --- | --- |
| Read Uncommitted (PG treats as Read Committed) | — | possible | possible | possible |
| **Read Committed (PostgreSQL default)** | no | possible | possible | possible |
| Repeatable Read (snapshot) | no | no | no (in PG) | write skew possible |
| Serializable | no | no | no | no |

### 3. Mental model
A transaction is a private draft. Read Committed means "every *statement* sees the latest committed data"; Repeatable Read means "the whole transaction sees one snapshot".

### 4. Delivery Plus mapping — **CURRENT**
- `OrdersRepository.create` saves an order with cascaded items via TypeORM `save`, which runs in **one transaction**: either the order and all its items exist, or none do.
- Most other writes are **single statements** (`UPDATE … WHERE …`), atomic by themselves, at Read Committed.
- What is **not** in a transaction: `createFromCart` writes the order (DB), then clears the cart (HTTP to cart-service), then publishes `order.created` (Kafka). Those three cannot share a transaction — the reason the outbox exists in the plan ([case study 13](case-studies/13-transactional-outbox.md)).

### 5. Example
```text
Read Committed, two sessions:
S1: BEGIN; SELECT status FROM orders WHERE id = X;   → PAYMENT_PENDING
S2: UPDATE orders SET status = 'CONFIRMED' WHERE id = X;  (commits)
S1: SELECT status FROM orders WHERE id = X;   → CONFIRMED   (non-repeatable read)
```

### 6. Failure scenario
"Check then act" inside Read Committed: `SELECT status` → in code `if (status === 'PAYMENT_PENDING')` → `UPDATE … SET status='CONFIRMED'`. Two writers both read PAYMENT_PENDING, both update, both publish `order.confirmed` → duplicate notifications. That was a real bug ([case study 06](case-studies/06-in-memory-idempotency.md)); the fix is in Chapter 6.

### 7. Trade-offs
Serializable prevents every anomaly but aborts transactions under contention; the application must retry them. Most systems use Read Committed plus targeted techniques (compare-and-set, `SELECT … FOR UPDATE`, unique constraints).

### 8. Performance
Long transactions hold locks and prevent vacuum from cleaning old row versions ([Book 05](05-postgresql-deep-dive.md)). Never hold a DB transaction open across an HTTP call.

### 9. Security — atomicity matters for audit: a half-applied refund is worse than none.
### 10. Operations — monitor `idle in transaction` sessions; they are almost always bugs.

### 11. Lab
[DB-04 Read phenomena in two psql sessions](labs/database-labs.md#db-04-read-phenomena-in-two-psql-sessions).

### 12. Verification
You reproduce a non-repeatable read at Read Committed and show it disappears at Repeatable Read.

### 13. Interview questions
- *Beginner:* What does atomic mean?
- *Intermediate:* What is PostgreSQL's default isolation level and what can go wrong?
- *Advanced:* What is write skew? Give a delivery-platform example.
- *Senior:* When would you choose Serializable, and what does the application then need to do?

### 14. Senior discussion
`createFromCart` cannot put the cart clear and the Kafka publish into the DB transaction. Rank the options: outbox, saga, or "accept and reconcile".

---

## Chapter 6 — Concurrency control: locks, CAS, lost updates and deadlocks

### 1. Why this exists
Concurrency bugs pass every unit test and appear under load, once a day, in production.

### 2. Core concept
- **Lost update**: two read-modify-write cycles interleave; one write overwrites the other.
- **Pessimistic locking**: lock first (`SELECT … FOR UPDATE`), others wait.
- **Optimistic concurrency**: don't lock; at write time, check nothing changed (a version column or the old value) and retry/abort if it did.
- **Compare-and-set (CAS)**: `UPDATE … SET status = :to WHERE id = :id AND status = :from` — the update applies only if the row is still in the expected state; `affected = 0` means you lost the race.
- **Deadlock**: two transactions each hold a lock the other needs. PostgreSQL detects it and aborts one.

### 3. Mental model
CAS turns a race into a *decision*: exactly one writer wins, the others learn they lost and can re-read and decide (no-op, retry, or error).

### 4. Delivery Plus mapping — **CURRENT** (this is the most important concurrency pattern in the codebase)
| Where | CAS |
| --- | --- |
| Order status | `OrdersRepository.updateStatus(id, from, to)` → `repo.update({ id, status: from }, { status: to })`, `affected` tells the winner (`services/order-service/src/repositories/orders.repository.ts`) |
| Payment status | `PaymentsRepository.transition(id, from, changes)` (`services/payment-service/src/repositories/payments.repository.ts`) |
| Delivery status | `DeliveriesRepository.transition(id, from, data)` (`services/delivery-service/src/repositories/deliveries.repository.ts`) |
| Payment side-effect lease | `acquireSideEffectsLease`: `UPDATE … SET "sideEffectsLeaseUntil" = now() + ttl WHERE id = :id AND ("sideEffectsLeaseUntil" IS NULL OR "sideEffectsLeaseUntil" < now())` |

What the service does after losing the race (`OrdersService.updateStatus`): re-read; if the row is already at the target status, return it and **publish nothing** (someone else already did); otherwise throw `InvalidStateTransitionError`.

**Same fix for drivers (issue #33):** driver status updates used to be a plain `UPDATE … WHERE id = :id` after checking the transition in code, a check-then-act race in which two assignments could both claim one driver. `DriversRepository.transitionStatus(id, from, to)` is now compare-and-set too; the loser gets a 409, and delivery-service tries the next driver.

### 5. Example
```sql
-- writer A and writer B both believe the order is PAYMENT_PENDING
UPDATE orders SET status = 'CONFIRMED' WHERE id = :id AND status = 'PAYMENT_PENDING';  -- A: UPDATE 1
UPDATE orders SET status = 'CONFIRMED' WHERE id = :id AND status = 'PAYMENT_PENDING';  -- B: UPDATE 0 → lost
```

### 6. Failure scenario
Before CAS, both payment-service's HTTP sync and order-service's `payment.completed` consumer confirmed the same order and each published `order.confirmed`; notification-service created two "Order Confirmed" notifications. After CAS, exactly one writer publishes.

### 7. Trade-offs
| | Pessimistic (`FOR UPDATE`) | Optimistic / CAS |
| --- | --- | --- |
| Contention high | good (queue) | many retries |
| Contention low | needless waiting | ideal |
| Across HTTP calls | dangerous (locks held during I/O) | safe |
| Deadlock risk | yes | no |

### 8. Performance
CAS is one statement, no lock held between read and write. That is why it fits a microservice that must call other services between deciding and writing.

### 9. Security
Race conditions are security bugs when money or permissions are involved (double refund, double spend). The partial unique index on payments is a race backstop.

### 10. Operations
`InvalidStateTransition` 409s in logs are the visible symptom of lost CAS races; a rising rate means more concurrent writers than expected.

### 11. Lab
[DB-05 Lost update vs compare-and-set](labs/database-labs.md#db-05-lost-update-vs-compare-and-set), [DB-07 Make a deadlock](labs/database-labs.md#db-07-make-a-deadlock).

### 12. Verification
In two sessions you reproduce a lost update with read-modify-write, then show only one CAS update reports `UPDATE 1`. You produce `ERROR: deadlock detected` and explain the lock order that caused it.

### 13. Interview questions
- *Beginner:* What is a race condition?
- *Intermediate:* Explain compare-and-set with the order status example.
- *Advanced:* When would you choose `SELECT … FOR UPDATE` over CAS?
- *Senior:* How do you prevent deadlocks in a codebase with many developers?

### 14. Senior discussion
The payment side-effect lease is time-based with no owner token, so a stale worker can release a newer worker's lease (issue #19). Design the fix (hint: fencing tokens, [Book 09](09-distributed-systems.md)).

---

## Chapter 7 — Durability: WAL, checkpoints, replication, backup and failover

### 1. Why this exists
"Committed" must mean "survives a power cut". And one server is one failure away from losing everything.

### 2. Core concept
- **WAL (write-ahead log)**: every change is appended to a log and flushed before the commit returns; data pages are written later. After a crash, PostgreSQL replays the WAL.
- **Checkpoint**: flushes dirty pages so recovery doesn't have to replay from the beginning.
- **Replication**: streaming the WAL to replicas. *Synchronous* (commit waits for a replica) or *asynchronous* (may lose the last moments on failover).
- **Read replica**: serves reads; can lag behind the primary.
- **Failover**: promote a replica when the primary dies.
- **Backup**: logical (`pg_dump`) or physical (base backup + WAL archive → point-in-time recovery, PITR).
- **RPO** (how much data you can lose) and **RTO** (how long you can be down).

### 3. Mental model
WAL is the ledger; data files are a cache of the ledger's result.

### 4. Delivery Plus mapping
- **CURRENT:** one PostgreSQL 16 container with a named volume `postgres_data` (`docker-compose.base.yml`). Durability = the volume.
- **NOT IMPLEMENTED:** replicas, backups, PITR, failover (issue #16 "document and validate PostgreSQL backup and restore", milestone Phase 9).
- One server hosts all nine databases: its loss takes down every service.

### 5. Example
```bash
dc exec postgres pg_dump -U postgres -d order_service -Fc -f /tmp/order_service.dump
dc exec postgres pg_restore -U postgres -d order_service_restore_test /tmp/order_service.dump  # after CREATE DATABASE
```

### 6. Failure scenario
`docker compose down -v` deletes `postgres_data`. Locally that's a reset; in a single-host deployment it's total data loss.

### 7. Trade-offs
Synchronous replication: no data loss, slower commits, the primary blocks if the replica is down. Asynchronous: fast, small loss window.

### 8. Performance
`synchronous_commit = off` makes commits faster by risking the last few hundred ms of commits on crash — acceptable for some data (analytics), never for payments.

### 9. Security
Backups contain every password hash and personal record; encrypt them and restrict access as tightly as production.

### 10. Operations
An untested backup is not a backup. Restore drills are part of issue #16's acceptance criteria.

### 11. Lab
[OPS-07 Backup and restore one service database](labs/devops-labs.md#ops-07-backup-and-restore-one-service-database).

### 12. Verification
You restore `order_service` into a new database and the order count matches.

### 13. Interview questions
- *Beginner:* What does durability mean?
- *Intermediate:* What is the WAL for?
- *Advanced:* Read-your-writes problems with asynchronous replicas?
- *Senior:* Define RPO/RTO for orders vs notifications and design backups for each.

### 14. Senior discussion
Nine logical databases on one server: is that database-per-service or not? When would you split them onto separate servers?

---

## Chapter 8 — Migrations, schema evolution and zero-downtime changes

### 1. Why this exists
The schema must change while the system is running and while old and new code versions coexist.

### 2. Core concept
- **Migration**: a versioned, ordered script (up, and optionally down) applied once; the database records which ran.
- **Expand → migrate → contract**: add the new thing (nullable column), deploy code that writes both, backfill, switch reads, then remove the old thing.
- **Online index creation**: `CREATE INDEX CONCURRENTLY`.
- Dangerous operations: adding `NOT NULL` without default on a big table, changing a column type, renaming a column old code still uses.

### 3. Mental model
During a rolling deploy, *old code runs against the new schema*. Every migration must be compatible with the previous release.

### 4. Delivery Plus mapping — **CURRENT**
- Migrations per service: `services/*/src/database/migrations/` (e.g. `services/auth-service/src/database/migrations/003-auth-security-fields.ts` adds `emailVerified`, `lockedUntil`, `failedLoginCount`, … with defaults — a textbook "expand" migration).
- `synchronize: false` everywhere (`services/*/src/database/typeorm.config.ts`).
- Migrations run **at container start**: the `Dockerfile` `CMD` runs `typeorm migration:run` before `node …/main.js`.
- CI: `.github/workflows/migration-verification.yml` runs all migrations on fresh databases and fails if any are pending; it also tests a legacy payment schema upgrade.
- Enum change example: `notification_type` includes `PAYMENT_COMPLETED`, `DRIVER_ASSIGNED`, … already, so new notification handlers (issue #5) won't need an enum migration.

### 5. Example — adding the order delivery address (issue #95), safely (this is what migration `003-order-delivery-address` does)
```sql
-- expand (compatible with old code)
ALTER TABLE orders ADD COLUMN "deliveryAddress" varchar NULL;
-- new code writes it on checkout; old orders keep NULL
-- later, if ever required: backfill, then ALTER … SET NOT NULL (fast in PG 12+ if a validated CHECK exists)
```

### 6. Failure scenario
Migrations at container start with **several replicas**: all replicas race to run the same migration. TypeORM takes a lock for its migrations table, but a long migration still blocks every replica's startup, and health checks may kill them mid-migration. Production systems usually run migrations as a separate one-off job before the rollout ([Book 18](18-cicd-and-devops.md), [Book 19](19-kubernetes.md)).

### 7. Trade-offs
Down migrations look safe but often can't restore dropped data. Many teams go forward-only and fix forward (`docs/deployment.md` documents forward-only expectations).

### 8. Performance
`ALTER TABLE … ADD COLUMN … DEFAULT <constant>` is instant in PostgreSQL 11+; adding an index without `CONCURRENTLY` locks writes for the whole build.

### 9. Security — migrations run with the same powerful credentials as the app here; a malicious or buggy migration has full access.
### 10. Operations — always know: which migration is applied in prod? (`npm run migration:show`).

### 11. Lab
[DB-09 Write and run a migration](labs/database-labs.md#db-09-write-and-run-a-migration).

### 12. Verification
`migration:show` lists your migration as applied; the service still starts; reverting the code (not the schema) still works.

### 13. Interview questions
- *Beginner:* Why not use `synchronize: true` in production?
- *Intermediate:* Expand/contract — walk through renaming a column.
- *Advanced:* How do you add a NOT NULL column to a 500 GB table without downtime?
- *Senior:* Migrations in the container entrypoint vs a separate job — choose for Delivery Plus.

### 14. Senior discussion
Enum types vs lookup tables vs varchar+check for statuses: which would you pick knowing the order lifecycle will gain states (issue #53)?

---

## Chapter 9 — Connection pooling, query plans, slow queries and N+1

### 1. Why this exists
Most "the database is slow" incidents are actually "the application is using the database badly".

### 2. Core concept
- **Connection**: an expensive server process in PostgreSQL (~MBs of RAM each). **Pool**: a fixed set reused by the app.
- **Query plan**: the planner's chosen algorithm (seq scan, index scan, nested loop, hash join…). `EXPLAIN` shows it; `EXPLAIN ANALYZE` runs it and shows real timings and row counts.
- **N+1**: one query for a list, then one query per item.

### 3. Mental model
```text
total connections = services × replicas × pool size
11 services × 2 replicas × 10 = 220  >  PostgreSQL default max_connections = 100
```

### 4. Delivery Plus mapping
- **CURRENT:** TypeORM (driver `pg`) default pool of 10 per service; `buildTypeOrmConfig` in each service sets no pool options. Nine service processes share one PostgreSQL server.
- **CURRENT (avoiding N+1):** `Order.items` is an eager relation, loaded with a join, not one query per order.
- **Cross-service N+1 risk:** anything that loops over orders and calls another service per item. `GET /api/users/me/orders` in user-service calls order-service once (good) — check `services/user-service/src/common/order-service.client.ts`.
- **NOT USED:** PgBouncer.

### 5. Example
```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM orders WHERE "customerId" = '…' ORDER BY "createdAt" DESC LIMIT 20;
```

### 6. Failure scenario
Pool exhaustion: a slow downstream HTTP call is made *while* a DB transaction holds a connection; all 10 connections wait on HTTP; every new request queues for a connection; latency explodes although PostgreSQL is idle.

### 7. Trade-offs
Bigger pools ≠ faster: past a point, more connections increase PostgreSQL contention. A transaction-mode pooler (PgBouncer) lets thousands of clients share tens of server connections, but breaks session features (prepared statements, `SET`, advisory locks).

### 8. Performance
Read plans for: estimated vs actual rows (bad statistics), `Seq Scan` on large tables, `Sort` spilling to disk, `Nested Loop` with large outer sides.

### 9. Security — `pg_stat_statements` can contain query text with literals; protect access to it.
### 10. Operations — enable slow-query logging (`log_min_duration_statement`) in production; it is off here.

### 11. Lab
[DB-03 Index vs sequential scan](labs/database-labs.md#db-03-index-vs-sequential-scan) and [DB-10 Exhaust the connection pool](labs/database-labs.md#db-10-exhaust-the-connection-pool).

### 12. Verification
You read an `EXPLAIN ANALYZE` and point to the node where most time is spent; you show `max_connections` and the current connection count per database from `pg_stat_activity`.

### 13. Interview questions
- *Beginner:* What is a connection pool?
- *Intermediate:* What is N+1 and how do you detect it?
- *Advanced:* Why can a larger pool make things slower?
- *Senior:* Size pools for 11 services, 3 replicas each, and one PostgreSQL server.

### 14. Senior discussion
Would you introduce PgBouncer before or after splitting the single PostgreSQL server? What application features would you have to audit first?

---

## Chapter 10 — Pagination strategies

### 1. Why this exists
Lists grow without bound; clients need them in pages that are fast and stable.

### 2. Core concept
- **Offset**: `ORDER BY … OFFSET (page-1)*limit LIMIT limit`. Simple, supports "page 7", gets slower with depth, unstable under inserts.
- **Keyset / cursor**: `WHERE (sort_key, id) < (:last_sort_key, :last_id) ORDER BY sort_key DESC, id DESC LIMIT limit`. Constant cost, stable, no random page jumps.

### 3. Mental model
Offset says "skip the first 10,000"; keyset says "continue after this bookmark".

### 4. Delivery Plus mapping — **CURRENT: offset everywhere**
`OrdersRepository.findByCustomer` / `findByRestaurant` (`skip`/`take`), `NotificationsRepository.findByUserId` (`take`/`skip`), restaurant listing (`.skip(...)`). Responses include `total` (a `COUNT`).

### 5. Example
```sql
-- keyset page after the last notification the client saw
SELECT * FROM notifications
WHERE "userId" = :user AND ("createdAt", id) < (:lastCreatedAt, :lastId)
ORDER BY "createdAt" DESC, id DESC
LIMIT 20;
```
Needs an index on `("userId", "createdAt", id)`.

### 6. Failure scenario
The id tie-breaker matters: two notifications created in the same millisecond without `id` in the cursor → one is skipped or duplicated forever.

### 7. Trade-offs — see the table in [Book 03 Chapter 4](03-http-apis-and-web.md#chapter-4--idempotency-keys-pagination-filtering-sorting-and-search).
### 8. Performance — offset: O(offset + limit); keyset: O(log n + limit).
### 9. Security — opaque cursors (base64 of the key) prevent clients from crafting arbitrary filters; sign them if they embed anything sensitive.
### 10. Operations — deep-page requests are often scrapers; rate-limit them.

### 11. Lab
[DB-06 Offset vs keyset pagination](labs/database-labs.md#db-06-offset-vs-keyset-pagination).

### 12. Verification
Timing for page 5,000: offset grows with depth; keyset stays flat.

### 13. Interview questions
- *Beginner:* What is offset pagination?
- *Intermediate:* Why does keyset need a unique tie-breaker?
- *Advanced:* How do you paginate a list sorted by a computed score?
- *Senior:* Migrate a public API from offset to cursor without breaking old app versions.

### 14. Senior discussion
The customer app shows recent orders and notifications only. Does it need deep pagination at all, or would "load more, max 200" be the better product and engineering decision?

---

## Chapter 11 — Database security and least privilege

### 1. Why this exists
The database holds everything an attacker wants. Application bugs (SQL injection, SSRF) become catastrophes when the app connects as a superuser.

### 2. Core concept
- **Least privilege**: each service gets a role that can do exactly what it needs on its own database — no `CREATE DATABASE`, no access to other services' data, no `SUPERUSER`.
- Separate roles for migrations (DDL) and runtime (DML).
- Network isolation, TLS to the database, encrypted backups, audit logging.

### 3. Mental model
Assume one service will be compromised. What can its credentials reach?

### 4. Delivery Plus mapping
- **CURRENT (weak):** every service connects as `postgres` (the superuser) — see `DATABASE_URL` values like `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/order_service` in `docker-compose.dev.yml` and `docker-compose.prod.yml`. Database-per-service isolation is by **convention**, not enforced: a compromised order-service could read `auth_service.credentials`.
- **CURRENT (good):** the production overlay requires credentials (`${POSTGRES_PASSWORD:?…}`) and publishes no database port; passwords are bcrypt hashes (`services/auth-service/src/services/auth.service.ts`, 10 rounds); verification tokens are stored hashed.
- **FUTURE:** one role per service, `REVOKE CONNECT` on other databases, separate migration role.

### 5. Example
```sql
CREATE ROLE order_service_app LOGIN PASSWORD '…';
REVOKE CONNECT ON DATABASE auth_service FROM PUBLIC;
GRANT CONNECT ON DATABASE order_service TO order_service_app;
\c order_service
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO order_service_app;
```

### 6. Failure scenario
SQL injection in any service + superuser connection = read every password hash, alter any payment, or `COPY … TO PROGRAM` (command execution on the database host).

### 7. Trade-offs
Per-service roles add setup and secret management work; they turn "one bug = total compromise" into "one bug = one service's data".

### 8. Performance — none.
### 9. Security — this whole chapter; see [Book 17](17-security-engineering.md).
### 10. Operations — rotate credentials per service independently; audit who connected (`log_connections`).

### 11. Lab
[SEC-06 Least-privilege role for one service](labs/security-labs.md#sec-06-least-privilege-role-for-one-service).

### 12. Verification
Connected as your new role, `SELECT * FROM credentials` in `auth_service` fails with permission denied, while order queries in `order_service` work.

### 13. Interview questions
- *Beginner:* What is least privilege?
- *Intermediate:* Why separate migration and runtime credentials?
- *Advanced:* What can an attacker do with a PostgreSQL superuser connection?
- *Senior:* Plan the migration from one superuser to per-service roles with zero downtime.

### 14. Senior discussion
If all services already share one PostgreSQL server, does per-service roles + one server give "good enough" isolation, or is the shared server itself the problem?

---

[Library index](README.md) · Previous: [Book 03](03-http-apis-and-web.md) · Next: [Book 05 — PostgreSQL Deep Dive](05-postgresql-deep-dive.md)
