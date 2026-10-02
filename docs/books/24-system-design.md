# Book 24 — System Design

[Library index](README.md) · Previous: [Book 23](23-geo-location-systems.md) · Next: [Book 25 — Payment Systems](25-payment-systems.md)

**Level:** Intermediate → Senior · **Prerequisites:** most earlier books; especially [Book 07](07-kafka.md), [Book 09](09-distributed-systems.md), [Book 10](10-microservices-and-domain-design.md).

System design is the skill of turning vague requirements into an architecture whose trade-offs you can defend. Delivery Plus gives you a rare advantage: every exercise below starts from a **real current design** you can inspect, so you can practise *evolving* a system rather than drawing one from nothing.

---

## Chapter 1 — The method

### 1. Requirements
- **Functional**: what the system does ("customer places an order and sees its status").
- **Non-functional**: latency, availability, durability, consistency, security, cost, compliance.
- **Constraints**: team size, budget, existing tech, deadlines.
- Ask until you know: users, scale, read/write ratio, peak factor, consistency needs per operation.

### 2. Estimation (back-of-the-envelope)
Example — a mid-size city:
```text
orders/day            100,000      → average 1.2/s, dinner peak ×10 ≈ 12 orders/s
events per order      ~10 order + 3 payment + 6 delivery ≈ 19 → ~230 events/s at peak
active deliveries     ~2,000 at peak
customer polling      2,000 / 10 s = 200 req/s (current design)
driver locations      3,000 online × 1 / 5 s = 600 writes/s (future)
order storage         ~2 KB/order + items ≈ 3 KB → 300 MB/day → ~110 GB/year
```
The numbers tell you what's *not* a problem (PostgreSQL write rate) and what might be (location fan-out, polling).

### 3. API and data model
Start from client screens; define resources, ownership, events.

### 4. High-level architecture
Boxes and arrows — then for every arrow: sync or async? what if it fails? what's the timeout? who retries?

### 5. Deep dives
Pick the 2–3 hardest parts (consistency, hot paths, failure modes) and go deep.

### 6. Trade-offs, evolution, operations
State what you chose *not* to do and when you'd revisit it.

### 7. Senior signals interviewers listen for
- Asking about consistency per operation instead of globally.
- Naming failure modes for every arrow.
- Estimating before scaling.
- Rejecting complexity that the numbers don't justify.
- Describing an evolution path, not just an end state.

---

## Chapter 2 — Exercise 1: Customer ordering

**Current design (CURRENT):** app → gateway → order-service (reads cart-service + restaurant-service, writes order + items in one transaction, clears cart, publishes `order.created`) → app → payment-service (creates payment, processes it, publishes `payment.*`, syncs order) → order-service converges via events too. Idempotency keys on order and payment creation; CAS on statuses.

| Aspect | Notes |
| --- | --- |
| Requirements | place order from cart; pay; never double-charge; see status |
| Assumptions | 12 orders/s peak; payment provider latency up to 2 s (future real gateway) |
| Bottlenecks | synchronous chain (~8 hops); PostgreSQL pool per service |
| Failure modes | cart clear fails after order commit; Kafka publish fails after commit (no outbox); payment response lost (handled by idempotency + settled-result replay) |
| Trade-offs | client-orchestrated checkout (simple, needs strict server checks) vs backend orchestrator; prices copied at add time vs re-validation at checkout (#42) |
| Evolution | checkout re-validation (#42) → outbox (#98) → backend checkout orchestration with a real payment provider (Book 25) |

Senior question: *Where must checkout be strongly consistent, and where is eventual fine?*

---

## Chapter 3 — Exercise 2: Driver dispatch

**Current design (CURRENT):** when the restaurant marks an order ready, delivery-service consumes `order.ready_for_pickup` and creates and assigns the delivery itself (#97; manual `POST /api/deliveries` + `/assign` remain for owners and admins). Assignment picks the most recently updated AVAILABLE driver, sets them BUSY, writes the assignment (CAS), syncs the order, publishes `delivery.driver_assigned`. Deliveries with no free driver wait and are retried by a periodic sweep. Also CURRENT: the driver current-delivery endpoint (#96) and exclusive driver claims (#33).

| Aspect | Notes |
| --- | --- |
| Requirements | every ready order gets a driver quickly; one driver ↔ one active delivery; fair distribution |
| Assumptions | 2,000 active deliveries, 3,000 online drivers per city |
| Architecture (target) | consumer of `order.ready_for_pickup` → create delivery (unique per order) → candidate search (GEO) → ranking → claim driver (CAS on driver status) → assignment → events; periodic sweep for unassigned deliveries |
| Bottlenecks | candidate search; contention on popular drivers |
| Failure modes | no driver available (must wait, not dead-letter); two dispatchers claim the same driver; driver goes offline after assignment; stale locations |
| Trade-offs | greedy vs batch matching; who owns availability (driver-service vs delivery-service) |
| Evolution | recency (now) → auto-dispatch greedy (#97) → distance-aware → batch per zone |

See [case study 19](case-studies/19-driver-dispatch.md).

---

## Chapter 4 — Exercise 3: Real-time tracking

**Current design:** driver location stored in Redis with TTL (CURRENT, unused by clients); customer polls delivery status every 10 s (CURRENT). **FUTURE:** push via WebSocket/SSE.

| Aspect | Notes |
| --- | --- |
| Requirements | customer sees driver position within ~5 s and status changes within seconds |
| Estimation | 600 location writes/s; 2,000 watchers; coalesce to 1 update / 3 s per delivery → ~700 pushes/s |
| Architecture | driver app → tracking ingestion (validate, rate-limit, plausibility) → Redis key (latest) + Pub/Sub channel per delivery → WebSocket servers (authorize via delivery ownership) → customer app; status from durable events |
| Bottlenecks | fan-out, connection count, reconnect storms |
| Failure modes | stale driver positions; missed status changes during disconnect (fix: snapshot on reconnect) |
| Trade-offs | polling vs push; Redis Pub/Sub vs Kafka for locations |
| Evolution | polling (now) → driver app sends locations → SSE/WebSocket for location, keep polling as fallback |

See [Book 22](22-real-time-systems.md), [case study 12](case-studies/12-future-websocket-tracking.md).

---

## Chapter 5 — Exercise 4: Notifications

**Current design (CURRENT):** notification-service consumes `order.confirmed` → inserts an inbox row; payment and delivery handlers exist but are no-ops (payloads lack `customerId`, #5); durable idempotency; customer app polls the inbox. **FUTURE:** push notifications (Expo push / FCM / APNs), preferences (#51), delivery retries/failure tracking (#50).

| Aspect | Notes |
| --- | --- |
| Requirements | exactly one notification per business event; timely; user preferences |
| Architecture | events → notification-service (dedup by eventId) → inbox row + outbound push job (with its own retries and provider idempotency) |
| Failure modes | duplicate notifications (marker/effect window); provider outages; invalid device tokens |
| Trade-offs | inbox + push vs push only; per-event vs digest |
| Evolution | add `customerId` to payloads (#5) → handlers → device tokens → push → preferences |

---

## Chapter 6 — Exercise 5: Search

**Current design (CURRENT):** `GET /api/restaurants?search=` → `ILIKE '%term%'` + offset pagination; no geo, no ranking; restaurant/menu caching per ID.

| Aspect | Notes |
| --- | --- |
| Requirements | find open restaurants near me by name/cuisine/dish, ranked |
| Architecture options | PostgreSQL trigram/full-text + PostGIS (stay in one DB) → dedicated search engine (OpenSearch) fed by events |
| Failure modes | index drift (search shows closed restaurants); slow queries |
| Trade-offs | operational cost of a search cluster vs PostgreSQL features |
| Evolution | trigram index → coordinates + radius filter → menu-item search → search engine when relevance tuning matters |

---

## Chapter 7 — Exercise 6: Payments

**Current design (CURRENT):** simulated provider (`Math.random() < PAYMENT_SUCCESS_RATE`), payment state machine with CAS, idempotency keys, side-effect markers and lease, admin-only refunds. Full treatment in [Book 25](25-payment-systems.md).

| Aspect | Notes |
| --- | --- |
| Requirements | never double-charge; every charge reconciles; refunds policy-driven |
| Architecture (target) | provider abstraction; authorize/capture; webhook ingestion with signature verification and dedup; reconciliation job; ledger |
| Failure modes | webhook before API response; duplicate webhooks; provider timeout with unknown outcome |
| Evolution | simulator → sandbox provider → production with reconciliation |

---

## Chapter 8 — Exercise 7: Analytics

**Current design:** **NOT PRESENT** — no analytics store; Kafka retains 7 days.

| Aspect | Notes |
| --- | --- |
| Requirements | orders per hour, delivery durations, dispatch times, conversion funnel |
| Architecture | Kafka → sink connector → warehouse (BigQuery/ClickHouse/Postgres replica) → dashboards; or CDC from service DBs |
| Failure modes | double counting (events at-least-once → dedup by eventId); schema drift (#23) |
| Trade-offs | events (business facts) vs CDC (table changes) as the source |
| Evolution | start with a nightly export of a read replica → event-based pipeline when needed |

---

## Chapter 9 — Exercise 8: Production deployment

**Current design:** Compose overlays; CI builds and scans images; no registry, no deployment. See [Book 18](18-cicd-and-devops.md), [Book 19](19-kubernetes.md).

| Aspect | Notes |
| --- | --- |
| Requirements | zero-downtime deploys, rollback, backups, monitoring, secrets |
| Architecture | managed PostgreSQL/Redis/Kafka + container platform + TLS edge + secret manager + observability stack |
| Failure modes | migrations during rollout, Kafka consumer rebalance storms, single-AZ outage |
| Trade-offs | managed services cost vs operational load |
| Evolution | single region, managed data stores, container platform → multi-AZ → (much later) multi-region |

---

## Chapter 10 — Practice protocol

For each exercise:
1. Write requirements and estimates on one page (30 min).
2. Draw the current design from the code (use [code-reading-guide.md](code-reading-guide.md)).
3. Draw your target design; mark every arrow sync/async with failure behaviour.
4. List three things you would *not* build yet and why.
5. Compare with the relevant case study and ADR.

Checkpoint: [checkpoints.md — Senior](checkpoints.md#senior-checkpoint).

---

[Library index](README.md) · Previous: [Book 23](23-geo-location-systems.md) · Next: [Book 25 — Payment Systems](25-payment-systems.md)
