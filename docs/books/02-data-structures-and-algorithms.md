# Book 02 — Data Structures & Algorithms (for Delivery Plus)

[Library index](README.md) · Previous: [Book 01](01-software-engineering-fundamentals.md) · Next: [Book 03 — HTTP, APIs & Web](03-http-apis-and-web.md)

**Level:** Junior → Advanced · **Prerequisites:** loops, recursion, basic TypeScript.

This is not a puzzle collection. Every structure and algorithm here answers a question the platform actually has — "which driver?", "how far?", "is this transition legal?", "which events did we already process?". Where the platform does not use an algorithm yet, the chapter is tagged **FUTURE** and the lab shows how you would try it.

**Labs for this book:** [geo-and-algorithms-labs.md](labs/geo-and-algorithms-labs.md).

---

## Chapter 1 — Complexity analysis and Big-O

### 1. Why this exists
Code that is fine with 10 restaurants can collapse with 100,000. Big-O lets you predict *how cost grows* before production tells you.

### 2. Core concept
- **Big-O** describes growth of time or memory as input size `n` grows, ignoring constants: O(1) constant, O(log n), O(n), O(n log n), O(n²).
- **Amortized** cost: the average per operation over a sequence (a dynamic array occasionally copies everything, but appends are O(1) amortized).
- **Time vs space**: you often buy speed with memory (an index, a cache, a hash set).
- Real systems add **I/O cost**: one network round trip (≈0.5–50 ms) dwarfs millions of CPU operations. Count round trips first.

### 3. Mental model
Ask two questions of any loop: "how many times does this run as data grows?" and "does each iteration do I/O?". An O(n) loop with an HTTP call inside is an O(n) *round trip* problem.

### 4. Delivery Plus mapping
| Operation | Code | Cost |
| --- | --- | --- |
| Find a cart line by menu item | `cart.items.find(...)` in `services/cart-service/src/services/cart.service.ts` | O(k), k = lines in cart (tiny — fine) |
| Rate-limit check | `INCR` + `EXPIRE` in `shared/src/redis/rate-limiter.service.ts` | O(1) per request, 1–2 Redis round trips |
| Idempotency claim | one Lua `EVAL` in `shared/src/kafka/durable-event-idempotency.service.ts` | O(1), 1 round trip |
| List a customer's orders, page p | `skip: (page - 1) * limit` in `services/order-service/src/repositories/orders.repository.ts` | O(page × limit) rows scanned and discarded by PostgreSQL |
| Restaurant search | `r.name ILIKE '%term%'` in `services/restaurant-service/src/repositories/restaurants.repository.ts` | O(n) — a leading wildcard cannot use a B-tree index |
| Pick a driver | `ORDER BY "updatedAt" DESC LIMIT 1` on AVAILABLE drivers (`services/driver-service/src/repositories/drivers.repository.ts`) | O(n) without an index on (status, updatedAt); O(log n) with one |

### 5. Example
Offset pagination: page 1 reads 20 rows; page 500 makes PostgreSQL walk 9,980 rows to throw them away. Keyset pagination (`WHERE ("createdAt", id) < ($1, $2) ORDER BY "createdAt" DESC, id DESC LIMIT 20`) is O(log n + limit) with the right index. Full treatment in [Book 04](04-database-fundamentals.md).

### 6. Failure scenario
N+1 round trips: listing 50 orders and then calling restaurant-service once per order = 51 network calls. At 5 ms each that's 255 ms of pure waiting, growing linearly.

### 7. Trade-offs
Optimising an O(k) loop over 5 cart lines is wasted effort. Optimising an O(n) table scan over all restaurants is not. Measure where `n` actually grows.

### 8. Performance
Rough latency ladder you should memorise: L1 cache ~1 ns · RAM ~100 ns · Redis round trip on the same host ~0.2–1 ms · PostgreSQL indexed query ~1 ms · cross-service HTTP ~2–10 ms · mobile network round trip 50–300 ms.

### 9. Security
Unbounded inputs turn complexity into a denial-of-service vector. `limit` query parameters must be capped (check the `ListOrdersQueryDto` in `services/order-service/src/dto/list-orders-query.dto.ts`); search terms need a maximum length.

### 10. Operations
Complexity shows up as latency percentiles that grow with data size, not traffic. Watch p95 of list endpoints as tables grow ([Book 21](21-performance-engineering.md)).

### 11. Lab
[GEO-01 Complexity of offset pagination](labs/geo-and-algorithms-labs.md#geo-01-complexity-of-offset-pagination) — insert 100k notifications, compare page 1 and page 4,000 with `EXPLAIN ANALYZE`.

### 12. Verification
You can show the planner's row counts grow with the offset and explain why.

### 13. Interview questions
- *Beginner:* What is the Big-O of looking up a key in a hash map?
- *Intermediate:* Why can an O(n) algorithm be faster than an O(log n) one in practice?
- *Advanced:* What is amortized complexity? Give an example from Redis or Kafka.
- *Senior:* How do you reason about cost when the dominant term is network round trips?

### 14. Senior discussion
At what data size would you change restaurant search from `ILIKE` to PostgreSQL full-text search or a search engine — and what would you lose?

---

## Chapter 2 — Arrays, hash maps and sets

### 1. Why this exists
These three structures answer most "store and find" questions. Picking the wrong one is the most common source of accidental O(n²).

### 2. Core concept
- **Array**: ordered, index lookup O(1), search O(n), insert in middle O(n).
- **Hash map**: key → value, average O(1) get/put, no order (JS `Map` preserves insertion order), worst case O(n) on collisions.
- **Set**: a hash map without values — "have I seen this?" in O(1).

### 3. Mental model
If you ask "does X exist?" or "find by ID" more than once, you want a map or set.

### 4. Delivery Plus mapping — **CURRENT**
- Cart lines are an **array** of `{ menuItemId, name, price, quantity }` (`services/cart-service/src/entities/cart.model.ts`). Fine: a cart has a handful of lines and order matters for display.
- The Kafka consumer's fallback deduplication is a **Set** of event IDs (`processedInMemory` in `shared/src/kafka/kafka-consumer.service.ts`) — O(1) membership but unbounded memory and lost on restart, which is exactly why it is only a fallback.
- Handlers are a **map of maps**: topic → (eventType → handler) (`handlers` in the same file). Dispatching a message is two O(1) lookups.
- The customer app de-duplicates concurrent requests with a **Map** of in-flight promises (`inflight` in `delivery-plus-customer-app/src/state/resource-cache.ts`): if two screens ask for the same key, only one HTTP request is sent.
- Redis itself is a giant hash map: every key (`cart:{userId}`, `driver:location:{userId}`) is an O(1) lookup.

### 5. Example
```ts
// O(n²): for each event, scan an array of processed IDs
if (processedArray.includes(event.eventId)) skip();

// O(1): set membership
if (processedSet.has(event.eventId)) skip();
```

### 6. Failure scenario
An unbounded in-memory Set grows forever in a long-running consumer — a slow memory leak. Real fixes: bound it (LRU), give entries a TTL, or move it to Redis with expiry (what `DurableEventIdempotencyService` does with a 7-day retention).

### 7. Trade-offs
Hash maps cost memory (load factor, pointers). For a few elements an array scan is faster than hashing. Sorted arrays support binary search and range queries; hash maps don't.

### 8. Performance
Average O(1) assumes a good hash function. Adversarial keys can force collisions (hash-flooding DoS); modern runtimes randomise hash seeds to prevent it.

### 9. Security
Using user-controlled strings as object keys in plain JS objects can hit `__proto__` (prototype pollution). Prefer `Map` for user-controlled keys.

### 10. Operations
In-process maps are per replica. Two replicas of a consumer have two different sets — the reason deduplication must be shared (Redis) once you scale out.

### 11. Lab
[GEO-02 Set vs array membership](labs/geo-and-algorithms-labs.md#geo-02-set-vs-array-membership) — benchmark `includes` vs `Set.has` for 10³…10⁶ IDs.

### 12. Verification
Your timings show linear growth for the array and flat growth for the set.

### 13. Interview questions
- *Beginner:* Array vs hash map — when do you use each?
- *Intermediate:* Why is the in-memory dedup set not enough for Kafka consumers?
- *Advanced:* How would you bound an in-memory set's memory?
- *Senior:* When do you move a data structure from process memory to Redis?

### 14. Senior discussion
The customer app's in-flight map deduplicates requests within one device. What would de-duplication across *devices* of the same customer require, and is it worth it?

---

## Chapter 3 — Queues, stacks and logs

### 1. Why this exists
Work arrives faster than it can be done, or must happen later, or must happen in order. Queues absorb that.

### 2. Core concept
- **Stack** (LIFO): last in, first out — call stacks, undo, DFS.
- **Queue** (FIFO): first in, first out — job queues, BFS, request buffering.
- **Log**: an append-only sequence where readers keep their own position (offset). Unlike a queue, reading does not delete. **Kafka partitions are logs.**

### 3. Mental model
```text
Queue:  producer → [ e3 e2 e1 ] → consumer   (consumed items disappear)
Log:    producer → [ e1 e2 e3 e4 ]           (items stay; each consumer group has its own offset)
                      ↑ group A at e2   ↑ group B at e4
```

### 4. Delivery Plus mapping
- **CURRENT:** `order.events`, `payment.events`, `delivery.events` are logs. order-service and notification-service read them independently because they are different consumer groups (`order-service-group`, `notification-service-group`).
- **CURRENT:** the dead-letter topics `<topic>.dlq` are logs too; `scripts/kafka-dlq.ts` keeps its own offset in the `delivery-plus-dlq-replay` group so each message is replayed once.
- **NOT USED:** a job queue (BullMQ, SQS). Retries happen inside the consumer with backoff.

### 5. Example
Replay is only possible because Kafka is a log: rewinding a consumer group's offset makes it re-read history. Lab KF-08 does exactly that.

### 6. Failure scenario
Treating a log like a queue: assuming "once consumed, it's gone". A rewind, a rebalance, or a crash before commit re-delivers messages. Consumers must be idempotent ([Book 08](08-idempotency-and-distributed-operations.md)).

### 7. Trade-offs
| | Queue | Log |
| --- | --- | --- |
| Many independent readers | hard | natural |
| Per-message ack / delete | natural | by offset (all-or-nothing up to a point) |
| Replay | no | yes |
| Ordering | usually per queue | per partition |

### 8. Performance
Appending to a log is sequential I/O — the fastest thing a disk does. That is why Kafka throughput is high.

### 9. Security
Logs keep data for the retention period. Personal data in events (Delivery Plus events carry `customerId`, not names or addresses) must respect privacy rules.

### 10. Operations
Queue depth / consumer lag is the key health metric ([Book 07](07-kafka.md), [case study 17](case-studies/17-consumer-lag.md)).

### 11. Lab
[KF-02 Consumer groups read independently](labs/kafka-labs.md#kf-02-consumer-groups-read-independently).

### 12. Verification
Two groups show different offsets for the same partition in `kafka-consumer-groups --describe`.

### 13. Interview questions
- *Beginner:* Stack vs queue?
- *Intermediate:* Why is a Kafka partition a log rather than a queue?
- *Advanced:* What does "commit an offset" mean, and what happens if you commit too early?
- *Senior:* When would you use a job queue instead of Kafka in this system?

### 14. Senior discussion
Delayed retries (retry in 5 minutes) are awkward on a log because offsets are sequential. Would you add retry topics, a scheduler, or a database-backed job table?

---

## Chapter 4 — Heaps, priority queues and top-k

### 1. Why this exists
"Give me the 5 nearest drivers" or "the 10 best-ranked restaurants" doesn't need a full sort.

### 2. Core concept
A **binary heap** keeps the smallest (or largest) element at the root. Push and pop are O(log n), peek is O(1). For **top-k** from n items, keep a max-heap of size k: O(n log k) instead of O(n log n) for a full sort.

### 3. Mental model
A heap is a tournament: only the winner is guaranteed to be at the top; the rest are "roughly sorted".

### 4. Delivery Plus mapping — **FUTURE**
No heap is used today. The natural place is driver selection ([Chapter 11](#chapter-11--algorithms-we-could-use-in-delivery-plus)): compute distance for candidate drivers, keep the k best. Redis sorted sets (skip lists, [Book 06](06-redis.md)) and Redis GEO give you top-k by score server-side.

### 5. Example
```ts
// top-k nearest with a bounded max-heap (sketch)
function topK<T>(items: T[], k: number, score: (t: T) => number): T[] {
  const heap: T[] = []; // keep as max-heap by score; simple version: sort small array
  for (const item of items) {
    heap.push(item);
    heap.sort((a, b) => score(a) - score(b));
    if (heap.length > k) heap.pop(); // drop the worst
  }
  return heap;
}
```
(The sort inside makes this O(n·k log k); a real heap makes it O(n log k). For k = 5 the difference is irrelevant — another reason to measure first.)

### 6. Failure scenario
Sorting all 50,000 online drivers on every order to take the first one: O(n log n) per dispatch, every few seconds, across every city.

### 7. Trade-offs
If the data store can do top-k (SQL `ORDER BY … LIMIT k` with an index, Redis `GEOSEARCH … COUNT k`), do it there: less data over the network.

### 8. Performance
O(n log k) CPU, but the real cost is fetching n candidates. Narrow candidates first (spatial index), then rank.

### 9. Security — not a primary concern.
### 10. Operations — a bad ranking is a business incident (late food), not a crash; log the chosen candidate and its score.

### 11. Lab
[GEO-05 Nearest K drivers](labs/geo-and-algorithms-labs.md#geo-05-nearest-k-drivers) implements top-k with and without a heap.

### 12. Verification
Both versions return the same k drivers; you can explain when each is faster.

### 13. Interview questions
- *Beginner:* What does a heap guarantee?
- *Intermediate:* Top-k from a stream of 10 million items with little memory?
- *Advanced:* How do you merge top-k results from several shards?
- *Senior:* Where should ranking run: in the database, in Redis, or in the service?

### 14. Senior discussion
Is "nearest driver" even the right objective? What if the nearest driver is about to go offline or is moving away?

---

## Chapter 5 — Trees, binary search and indexes

### 1. Why this exists
Every fast database lookup in this platform is a tree search.

### 2. Core concept
- **Binary search**: in a sorted array, halve the range each step — O(log n).
- **B-tree / B+tree**: a wide, shallow balanced tree designed for disks: each node holds hundreds of keys, so a million rows are 3–4 levels deep. PostgreSQL's default index.
- **Skip list**: probabilistic layered linked lists; O(log n) search. Redis sorted sets use one.

### 3. Mental model
An index is a sorted copy of some columns with pointers back to the rows. "Can the index help?" = "is my condition a prefix-range of the sort order?".

### 4. Delivery Plus mapping — **CURRENT**
Real B-tree indexes in the migrations:
- `UQ_credentials_email` (`services/auth-service/src/database/migrations/001-initial-schema.ts`) — login looks up by email in O(log n).
- `IDX_orders_customerId`, partial unique `UQ_orders_customer_idempotency_key` (`services/order-service/src/database/migrations/001-initial-schema.ts`).
- `UQ_deliveries_orderId` — the order → delivery lookup and the "one delivery per order" rule.
- `UQ_payments_active_order` — a **partial** unique index: only one PENDING/PROCESSING/COMPLETED payment per order.

### 5. Example
`WHERE "customerId" = $1 ORDER BY "createdAt" DESC` uses `IDX_orders_customerId` to find the rows, then sorts them. A composite index on `("customerId", "createdAt")` would return them already sorted. Lab DB-03 measures the difference.

### 6. Failure scenario
`name ILIKE '%pizza%'`: the leading `%` means "match anywhere", so the B-tree's sort order is useless — sequential scan.

### 7. Trade-offs
Every index speeds reads and slows writes (each insert updates every index) and costs disk/RAM.

### 8. Performance
B-tree depth grows with log base ~200 of n: 1 billion rows ≈ 4–5 levels.

### 9. Security — unique indexes enforce business invariants even when application code has a race (see payments).
### 10. Operations — creating an index on a big table locks writes unless you use `CREATE INDEX CONCURRENTLY` ([Book 05](05-postgresql-deep-dive.md)).

### 11. Lab
[DB-03 Index vs sequential scan](labs/database-labs.md#db-03-index-vs-sequential-scan).

### 12. Verification
`EXPLAIN` switches from `Seq Scan` to `Index Scan` after you add the index, and the actual time drops.

### 13. Interview questions
- *Beginner:* Why is binary search O(log n)?
- *Intermediate:* Why does `LIKE 'abc%'` use an index but `LIKE '%abc'` not?
- *Advanced:* What is a partial index and where does Delivery Plus use one?
- *Senior:* How do you decide which indexes a new feature needs before it ships?

### 14. Senior discussion
`UQ_payments_active_order` enforces a business rule in the database. Should business rules live in the database at all? What happens when the rule changes?

---

## Chapter 6 — Graphs: state machines, BFS and DFS

### 1. Why this exists
Order, payment, delivery and driver lifecycles are **graphs**: statuses are nodes, allowed transitions are edges. Graph algorithms answer "is this transition legal?", "can we ever reach DELIVERED from here?", "is there a cycle?".

### 2. Core concept
- **Directed graph**: edges have direction.
- **BFS** (breadth-first, uses a queue): shortest path in steps; "what is reachable?".
- **DFS** (depth-first, uses a stack/recursion): cycle detection, topological order.
- A **DAG** (directed acyclic graph) has no cycles: a one-way lifecycle.

### 3. Mental model
```text
CREATED → PAYMENT_PENDING → CONFIRMED → PREPARING → READY_FOR_PICKUP → DRIVER_ASSIGNED → PICKED_UP → DELIVERED
   │              │  └→ FAILED      │           │              │                 │              │
   └──────────────┴────────→ CANCELLED ←────────┴──────────────┴─────────────────┴──────────────┘
```
The order lifecycle is a DAG. That is not a coincidence: it is what makes `lifecycleEventId(order, type)` unique — each node is visited at most once.

### 4. Delivery Plus mapping — **CURRENT**
- Adjacency lists: `ORDER_TRANSITIONS`, `DELIVERY_TRANSITIONS`, `PAYMENT_TRANSITIONS`, `DRIVER_TRANSITIONS` in `shared/src/types/enums.ts`.
- Edge check: `isTransitionAllowed(transitions, from, to)` — O(out-degree).
- **Path walking:** `syncOrderAlongDelivery` in `services/delivery-service/src/services/deliveries.service.ts` walks the order forward along `READY_FOR_PICKUP → DRIVER_ASSIGNED → PICKED_UP → DELIVERED` one allowed edge at a time, so an order left behind by a failed sync catches up.
- Note `DRIVER_TRANSITIONS` is **not** a DAG: AVAILABLE ↔ BUSY cycles forever. That is why driver events cannot use "one ID per (driver, status)" deduplication.

### 5. Example
```ts
// BFS: every status reachable from `start`
function reachable<T extends string>(graph: Record<T, T[]>, start: T): Set<T> {
  const seen = new Set<T>([start]);
  const queue: T[] = [start];
  while (queue.length) {
    const s = queue.shift()!;
    for (const next of graph[s] ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  }
  return seen;
}
```

### 6. Failure scenario
A new status added without edges becomes a dead end; an edge added carelessly (DELIVERED → PREPARING) creates a cycle that breaks deterministic event IDs and lets an order be "delivered" twice.

### 7. Trade-offs
A transition table is simple and testable. A workflow engine (**NOT USED**) adds timers, compensation and visual tooling, at a large operational cost.

### 8. Performance — tiny graphs; everything is O(1) in practice.
### 9. Security — the graph is also an authorization surface: `order-transition-rules.ts` decides which *role* may traverse which edge.

### 10. Operations — illegal transitions surface as 409 `InvalidStateTransition`; a spike means two writers disagree.

### 11. Lab
[GEO-03 Validate the lifecycle graphs](labs/geo-and-algorithms-labs.md#geo-03-validate-the-lifecycle-graphs) — import the four transition tables, prove which are DAGs, and list the terminal states.

### 12. Verification
Your script reports order, delivery and payment as acyclic, driver as cyclic, and finds every status from which DELIVERED is still reachable.

### 13. Interview questions
- *Beginner:* What is a state machine?
- *Intermediate:* BFS vs DFS — when do you use each?
- *Advanced:* Why does a cycle in a lifecycle break deterministic event IDs?
- *Senior:* How would you migrate live orders when you add a new status in the middle of the graph?

### 14. Senior discussion
Customers may currently cancel from any non-terminal order status (issue #53). How would you express "who may cancel when" — more edges, edge conditions, or a separate policy module?

---

## Chapter 7 — Shortest paths: Dijkstra and A* (routing & ETA)

### 1. Why this exists
ETA and "nearest by road" are shortest-path problems on a road graph.

### 2. Core concept
- **Dijkstra**: from a start node, repeatedly settle the closest unsettled node (priority queue). O((V + E) log V). Non-negative weights only.
- **A\***: Dijkstra plus a heuristic `h(n)` (e.g. straight-line distance to the goal) that steers the search; with an admissible heuristic it stays optimal and explores far fewer nodes.

### 3. Mental model
Dijkstra floods outwards in rings of equal cost. A* floods in a cone pointed at the destination.

### 4. Delivery Plus mapping — **FUTURE**
Delivery Plus stores no coordinates for restaurants or customers today (restaurants have a text `address`; orders have no address — issue #95). Only the driver's last location exists (`driver:location:{userId}` in Redis). Any routing is future work; realistically it would be bought (OSRM, Valhalla, Google/Mapbox) rather than built ([Book 23](23-geo-location-systems.md)).

### 5. Example
A* on a grid with Manhattan distance as `h` — see the lab.

### 6. Failure scenario
Using straight-line distance as ETA in a city with a river and two bridges: the "nearest" driver is 40 minutes away by road.

### 7. Trade-offs
Build: full control, enormous effort (map data, traffic). Buy: per-request cost, vendor dependency, rate limits. Hybrid: precomputed travel-time matrices per zone.

### 8. Performance
City road graphs have millions of nodes; production routers use precomputation (contraction hierarchies) to answer in milliseconds.

### 9. Security — routing requests to third parties leak customer locations; minimise and anonymise.
### 10. Operations — a routing provider outage must degrade gracefully (fall back to straight-line × factor).

### 11. Lab
[GEO-06 Dijkstra vs A* on a grid](labs/geo-and-algorithms-labs.md#geo-06-dijkstra-vs-a-on-a-grid).

### 12. Verification
A* expands fewer nodes than Dijkstra and finds the same path cost.

### 13. Interview questions
- *Beginner:* What does Dijkstra compute?
- *Intermediate:* What makes an A* heuristic admissible?
- *Advanced:* Why can't Dijkstra handle negative weights?
- *Senior:* Would you build routing for Delivery Plus? Justify with cost and risk.

### 14. Senior discussion
ETA shown to customers is a promise. Is a conservative ETA (always late-safe) better than an accurate-on-average one?

---

## Chapter 8 — Greedy algorithms, ranking and matching (dispatch)

### 1. Why this exists
Dispatch is the heart of a delivery business: which driver gets which order.

### 2. Core concept
- **Greedy**: make the locally best choice now (nearest free driver). Simple, fast, often good, sometimes globally bad.
- **Ranking**: compute a score per candidate from several signals (distance, idle time, rating, vehicle).
- **Matching**: assign many orders to many drivers at once to minimise total cost — the assignment problem (Hungarian algorithm O(n³)) or min-cost flow.

### 3. Mental model
Greedy answers each order alone. Batch matching waits a few seconds, collects orders, and solves them together.

### 4. Delivery Plus mapping
- **CURRENT:** `DeliveriesService.assignDriver` → `DriverServiceClient.findAvailableDriver()` → `GET /drivers/available?page=1&limit=1` → `findAvailable` in `services/driver-service/src/repositories/drivers.repository.ts`, ordered by `updatedAt DESC`. That is a *recency* heuristic: the driver who most recently changed status wins. No distance is involved.
- **PLANNED:** automatic dispatch on `order.ready_for_pickup` (issue #97) — still greedy, but triggered by an event.
- **FUTURE:** distance-aware ranking and batch matching.

### 5. Example
```text
Orders: O1 (north), O2 (south)        Drivers: D1 (centre), D2 (far north)
Greedy, in arrival order:  O1 → D1 (nearest),  O2 → D2 (very far)   total = 2 + 9 = 11
Batch matching:            O1 → D2,            O2 → D1             total = 3 + 3 = 6
```

### 6. Failure scenario
The current recency heuristic plus "online/offline toggling" means a driver can jump the queue by toggling status. The seed scripts even rely on this (`prepareDriver` in `scripts/lib/gateway-seed.ts` cycles the driver offline → online so it is picked). Fine for a demo, unfair in production.

### 7. Trade-offs
| Strategy | Latency | Quality | Complexity |
| --- | --- | --- | --- |
| Recency (current) | instant | ignores distance | trivial |
| Greedy nearest | instant | good locally | needs locations |
| Batch matching | +N seconds wait | best total | solver, batching, fairness |

### 8. Performance
Greedy: O(candidates) per order. Hungarian: O(n³) per batch — fine for a few hundred per zone, too slow city-wide; partition by zone.

### 9. Security
Ranking must use server-side data only. A driver app must not be able to claim a fake location to win orders (location trust is issue #60).

### 10. Operations
Log every dispatch decision with candidates and scores; you will need it to answer "why did driver X get this order?".

### 11. Lab
[GEO-07 Greedy vs batch assignment](labs/geo-and-algorithms-labs.md#geo-07-greedy-vs-batch-assignment).

### 12. Verification
Your batch solution has a lower total distance than greedy on the provided example, and you can explain the extra latency.

### 13. Interview questions
- *Beginner:* What is a greedy algorithm?
- *Intermediate:* Why is "nearest driver" not always optimal?
- *Advanced:* How would you add fairness (idle time) to the score?
- *Senior:* Design dispatch for 10 cities with very different densities.

### 14. Senior discussion
Should dispatch be a separate service, part of delivery-service, or part of driver-service? Who owns the driver's "current delivery" — see [case study 19](case-studies/19-driver-dispatch.md).

---

## Chapter 9 — Caching algorithms

### 1. Why this exists
Memory is limited; you must decide what to keep and what to evict.

### 2. Core concept
- **TTL**: entries expire after a time.
- **LRU**: evict the least recently used (hash map + doubly linked list = O(1)).
- **LFU**: evict the least frequently used.
- **Stale-while-revalidate (SWR)**: serve the cached value immediately, refresh in the background.

### 3. Mental model
A cache is a bet that the past predicts the future. TTL bounds how wrong it can be; eviction bounds how much it costs.

### 4. Delivery Plus mapping — **CURRENT**
- Backend: `CacheService.getOrSet` in `shared/src/redis/cache.service.ts` (cache-aside with optional TTL) caches `restaurant:{id}`, `menu:{restaurantId}`, `menuitem:{id}` with 30–60 s TTLs (`services/restaurant-service/src/services/restaurants.service.ts`, `services/menu-service/src/services/menu.service.ts`), invalidated with `del` on writes.
- Client: SWR with a 10-second stale time in `delivery-plus-customer-app/src/hooks/use-resource.ts` and `src/state/resource-cache.ts`.
- Redis eviction policy: not configured in Compose (Redis default `noeviction` — writes fail when memory is full rather than evicting).

### 5. Example
`getOrSet` checks `if (cached) return cached;`. A cached value that is falsy (`0`, `""`, `false`) is treated as a miss — harmless for objects, a subtle bug for primitives.

### 6. Failure scenario
**Cache stampede**: a popular menu expires; 500 concurrent requests all miss and all query PostgreSQL. `getOrSet` has no lock or request coalescing. Lab RD-03 reproduces it.

### 7. Trade-offs
Short TTL = fresher data, more DB load. Long TTL = stale prices/availability. Explicit invalidation = fresh, but every writer must remember to invalidate.

### 8. Performance
LRU O(1) per operation. Redis approximates LRU by sampling keys (cheaper, nearly as good).

### 9. Security
Caches keyed only by resource ID must never hold per-user data. Menu data is public; carts are not cached through `CacheService`.

### 10. Operations
Watch hit ratio; a 0% hit ratio after a deploy usually means a key-format change.

### 11. Lab
[RD-03 Cache stampede on the menu](labs/redis-labs.md#rd-03-cache-stampede-on-the-menu).

### 12. Verification
You count N database queries for N concurrent misses, then 1 query after adding a lock or single-flight.

### 13. Interview questions
- *Beginner:* What is a TTL?
- *Intermediate:* How do you implement LRU in O(1)?
- *Advanced:* Three ways to prevent a cache stampede.
- *Senior:* When is caching the wrong answer?

### 14. Senior discussion
Menu prices are cached, and carts copy prices at add time (issue #42). Where should the price truth be checked: cache, cart, or checkout?

---

## Chapter 10 — Spatial search: distance, geohash, H3, trees and k-nearest neighbours

### 1. Why this exists
"Which drivers are within 3 km?" over 50,000 drivers must not compute 50,000 distances per request.

### 2. Core concept
- **Haversine** distance between two lat/lng points on a sphere.
- **Bounding box** prefilter: a cheap rectangle test before the exact distance.
- **Geohash**: interleave lat/lng bits into a string; nearby points often share a prefix. Neighbour cells needed at edges.
- **H3** (Uber): hierarchical hexagonal cells; uniform neighbours, good for aggregation and zones.
- **R-tree** (rectangles), **KD-tree** (points, k dimensions): tree indexes for spatial queries; PostGIS uses GiST (R-tree-like).
- **kNN**: k nearest neighbours — answered by spatial indexes in O(log n + k).

### 3. Mental model
Spatial indexes turn "compute distance to everyone" into "look only in nearby buckets, then compute exact distance for those".

### 4. Delivery Plus mapping
- **CURRENT:** driver positions are stored as JSON `{ userId, latitude, longitude, updatedAt }` under `driver:location:{userId}` with a 300 s TTL (`services/tracking-service/src/repositories/location.repository.ts`). Lookup is by driver only; there is no "drivers near X" query.
- **CURRENT:** coordinates are validated with `@IsLatitude()` / `@IsLongitude()` (`services/tracking-service/src/dto/update-location.dto.ts`).
- **FUTURE:** Redis GEO (`GEOADD`/`GEOSEARCH`), PostGIS, or H3 for nearest-driver search ([Book 23](23-geo-location-systems.md)).

### 5. Example
```ts
function haversineKm(a: {lat: number; lng: number}, b: {lat: number; lng: number}): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
```

### 6. Failure scenario
Geohash edge effect: a driver 50 m away across a cell boundary has a different prefix and is missed unless you also search the 8 neighbouring cells.

### 7. Trade-offs
| Approach | Strength | Weakness |
| --- | --- | --- |
| Brute force Haversine | correct, trivial | O(n) per query |
| Redis GEO | fast, already have Redis, TTL-friendly data | no polygons; geohash-based approximations |
| PostGIS | rich queries (polygons, zones) | heavier writes for frequent location updates |
| H3 cells | zones, aggregation, surge pricing | approximate distances, a library to manage |

### 8. Performance
Brute force 50k drivers × Haversine ≈ a few ms of CPU — fine once, not 100 times per second per city. Spatial index: O(log n + k).

### 9. Security — exact driver positions are personal data; return distances or coarse cells to customers, not raw coordinates of every nearby driver.
### 10. Operations — stale locations (TTL expiry) must remove drivers from candidates automatically.

### 11. Lab
[GEO-04 Haversine and bounding box](labs/geo-and-algorithms-labs.md#geo-04-haversine-and-bounding-box), [RD-06 Redis GEO nearest drivers](labs/redis-labs.md#rd-06-redis-geo-nearest-drivers).

### 12. Verification
Your brute-force and Redis GEO results agree for the same data set; Redis answers in sub-millisecond time.

### 13. Interview questions
- *Beginner:* Why can't you use Euclidean distance on lat/lng directly?
- *Intermediate:* How does geohash find nearby points?
- *Advanced:* Geohash vs H3 — when do hexagons help?
- *Senior:* Design nearest-driver search for one million location updates per minute.

### 14. Senior discussion
Driver location lives in Redis with a TTL; drivers' status lives in PostgreSQL in driver-service. A nearest-*available*-driver query needs both. Where should the join happen?

---

## Chapter 11 — Algorithms we could use in Delivery Plus

Everything in this chapter is **FUTURE** unless stated otherwise. For each problem: the problem, a naive solution, an optimized one, complexity, limits, and a lab.

### 11.1 Nearest driver search
- **Problem:** given a pickup point, find available drivers nearby.
- **Current (CURRENT):** recency, not distance (Chapter 8).
- **Naive:** load all AVAILABLE drivers, look up each one's location in Redis, compute Haversine, take the min. O(n) Redis reads + O(n) math.
- **Optimized:** maintain a Redis GEO set of *available* drivers (add on AVAILABLE + location update, remove on BUSY/OFFLINE or TTL); `GEOSEARCH FROMLONLAT … BYRADIUS 3 km ASC COUNT 10`. O(log n + k).
- **Limits:** GEO sets have no per-member TTL — stale members must be removed explicitly (e.g. a sorted set of last-seen times swept periodically). Availability lives in driver-service; keeping two sources in sync is the hard part.
- **Lab:** [GEO-05](labs/geo-and-algorithms-labs.md#geo-05-nearest-k-drivers), [RD-06](labs/redis-labs.md#rd-06-redis-geo-nearest-drivers). Case study: [20](case-studies/20-nearest-driver-search.md).

### 11.2 Driver ranking
- **Naive:** distance only.
- **Optimized:** weighted score `w1·eta + w2·idleTimePenalty + w3·acceptanceRate…`, top-k by heap or sorted set.
- **Limits:** weights need data and A/B testing; scores must be explainable.

### 11.3 Restaurant search
- **Current (CURRENT):** `ILIKE '%term%'` + offset pagination, O(n).
- **Optimized:** PostgreSQL full-text search (`tsvector` + GIN) or trigram index (`pg_trgm` + GIN) for fuzzy match; later geo filter ("open restaurants within 5 km") once restaurants have coordinates.
- **Limits:** ranking by relevance + distance + rating usually ends in a search engine (OpenSearch) — a big operational step.
- **Lab:** [DB-08 Trigram search vs ILIKE](labs/database-labs.md#db-08-trigram-search-vs-ilike).

### 11.4 Dispatch
- **Naive:** greedy on order arrival.
- **Optimized:** micro-batching per zone (H3 cell) every few seconds + assignment solver; re-offer on rejection with a timeout.
- **Limits:** latency vs quality; fairness; drivers rejecting offers.
- **Lab:** [GEO-07](labs/geo-and-algorithms-labs.md#geo-07-greedy-vs-batch-assignment). Case study: [19](case-studies/19-driver-dispatch.md).

### 11.5 ETA
- **Naive:** `haversine / averageSpeed`.
- **Optimized:** routing engine travel time + restaurant preparation time + historical correction per zone and hour.
- **Limits:** needs historical data the platform does not collect yet (no analytics store).

### 11.6 Geofencing
- **Problem:** detect "driver arrived at restaurant" automatically.
- **Naive:** distance(driver, restaurant) < 100 m on every location update.
- **Optimized:** point-in-polygon against an H3 cell set or PostGIS polygon; hysteresis (must be inside for N seconds) to absorb GPS noise.
- **Limits:** GPS drift in dense cities; trust boundary (issue #60 — geofence events must derive from server state, not client claims).
- **Lab:** [GEO-08 Geofence with hysteresis](labs/geo-and-algorithms-labs.md#geo-08-geofence-with-hysteresis).

---

[Library index](README.md) · Previous: [Book 01](01-software-engineering-fundamentals.md) · Next: [Book 03 — HTTP, APIs & Web](03-http-apis-and-web.md)
