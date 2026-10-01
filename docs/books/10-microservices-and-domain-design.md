# Book 10 — Microservices & Domain Design

[Library index](README.md) · Previous: [Book 09](09-distributed-systems.md) · Next: [Book 11 — NestJS / TypeScript Backend Engineering](11-nestjs-typescript-backend.md)

**Level:** Intermediate → Senior · **Prerequisites:** [Book 01](01-software-engineering-fundamentals.md), [Book 07](07-kafka.md), [Book 09](09-distributed-systems.md).

Delivery Plus is split into 12 services. This book asks *why*, maps each boundary, shows how they integrate, and — at the senior level — challenges whether every boundary is in the right place.

---

## Chapter 1 — Monolith, modular monolith, microservices

### 1. Why this exists
Architecture style decides how teams deploy, how failures spread, and how much of your time goes to infrastructure instead of features.

### 2. Core concept
- **Monolith**: one deployable, one database. Simple to build, test, deploy and debug; scaling and team autonomy get harder as it grows.
- **Modular monolith**: one deployable, strong internal module boundaries (no reaching into another module's tables).
- **Microservices**: independently deployable services, each owning its data, talking over the network.
- **Distributed monolith**: microservices that must be deployed together, share types and data assumptions, and fail together — the costs of both styles, the benefits of neither.

### 3. Mental model
Microservices trade **in-process complexity** for **distributed complexity**. That trade pays off when independent deployment, scaling or team ownership is worth the network.

### 4. Delivery Plus mapping — **CURRENT**
- 12 deployables (`services/*`), one image recipe (`Dockerfile` with `SERVICE_NAME`), one repository, one shared library (`shared/`), one Compose file per environment.
- Database per service (nine PostgreSQL databases), but **one PostgreSQL server** and **one Redis** for all.
- Everything is versioned and released together (one repo, one CI). Honest classification: **microservices in structure, a monorepo-deployed system in practice** — closer to a well-modularised distributed system than to independently released services.

### 5. Example — adding a field to `DeliveryPayload` (`shared/src/events/delivery-events.ts`) changes a shared type used by delivery-, order- and notification-service. In a monorepo, one PR updates all three; with independent repos, it would need a versioned contract.
### 6. Failure scenario — the distributed-monolith trap: a change in `shared/` that every service must pick up simultaneously; a deploy that updates only some services breaks the others.
### 7. Trade-offs
| | Monolith | Modular monolith | Microservices |
| --- | --- | --- | --- |
| Deploy | one unit | one unit | per service |
| Consistency | ACID transactions | ACID transactions | sagas, eventual |
| Failure isolation | low | low | higher (if designed) |
| Ops cost | low | low | high (12× health, logs, configs) |
| Team autonomy | low | medium | high |

### 8. Performance — in-process calls (ns) vs network calls (ms); checkout here involves ~8 network hops.
### 9. Security — more services = more endpoints, more credentials, more internal attack surface.
### 10. Operations — 12 services × (logs, health, migrations, config, scaling) is real operational work for a small team.

### 11. Lab
Count the network hops in one checkout using logs (correlation IDs) or [code-reading-guide.md](code-reading-guide.md#order-creation). Estimate the latency if each hop costs 3 ms.

### 12. Verification
You produce a hop list and a latency estimate, and name one hop that would disappear in a modular monolith.

### 13. Interview questions
- *Beginner:* What is a microservice?
- *Intermediate:* What is a distributed monolith?
- *Advanced:* When does a modular monolith beat microservices?
- *Senior:* Would you build Delivery Plus as microservices again for a team of three?

### 14. Senior discussion
If you had to merge services to reduce operational load, which pairs would you merge first, and what would you lose? (See Chapter 6.)

---

## Chapter 2 — Bounded contexts and the Delivery Plus context map

### 1. Why this exists
A word like "order", "delivery" or "user" means different things to different parts of the business. Boundaries should follow those meanings.

### 2. Core concept
- **Domain**: the business problem. **Subdomain**: a part of it (ordering, payments, dispatch).
- **Bounded context**: a boundary inside which a model and its language are consistent.
- **Context map**: how contexts relate (upstream/downstream, customer/supplier, shared kernel, anticorruption layer).

### 3. Mental model
A service boundary is a *language* boundary. If two services constantly need each other's internal concepts, they are probably one context.

### 4. Delivery Plus mapping — **CURRENT**
| Context | Service | Owns | Key concepts |
| --- | --- | --- | --- |
| Identity | auth-service (`credentials`) | credentials, roles, verification, lockout | email, password hash, role |
| Profile | user-service (`user_profiles`) | name, phone, address, avatar | profile |
| Catalogue | restaurant-service, menu-service | restaurants, categories, menu items, images | ownerId, availability, price |
| Shopping | cart-service (Redis) | carts | lines, one restaurant per cart |
| Ordering | order-service | orders, order items, order lifecycle | status, idempotency key |
| Payments | payment-service | payments, payment lifecycle | status, side-effect markers |
| Fulfilment | delivery-service | deliveries, dispatch | assignment, delivery lifecycle |
| Fleet | driver-service | driver profiles, availability | AVAILABLE/BUSY/OFFLINE |
| Location | tracking-service (Redis) | current location | lat/lng, TTL |
| Messaging | notification-service | inbox | notification type, read |
| Edge | api-gateway | routing, CORS, internal-route blocking | — |

```text
            ┌────────────┐   creates profile (HMAC)   ┌────────────┐
            │  auth      │───────────────────────────►│  user      │──► order (my orders, proxied)
            └────────────┘                            └────────────┘
 ┌──────────┐ ownership ┌────────────┐ items/prices ┌────────┐ cart ┌──────────┐ status ┌─────────────┐
 │restaurant│◄──────────│   menu     │◄─────────────│  cart  │◄─────│  order   │◄───────│  payment    │
 └──────────┘           └────────────┘              └────────┘      └──────────┘ events └─────────────┘
       ▲  ownership                                                    ▲   ▲ status/events
       └───────────────────────────────────────────────────────────────┘   │
                                                          ┌─────────────┐  │  ┌────────┐
                                                          │  delivery   │──┘─►│ driver │◄── tracking
                                                          └─────────────┘     └────────┘
                       notification ◄── order.events / payment.events / delivery.events (Kafka)
```

### 5. Example — "status" means three different things: `order_status` (10 values), `delivery_status` (6), `driver_status` (4). The **mapping** between them lives in delivery-service (`ORDER_DELIVERY_PATH`, `syncOrderAlongDelivery`) — a translation between contexts, like an anticorruption layer.

### 6. Failure scenario — the driver's availability (fleet context) and the driver's current assignment (fulfilment context) live in different services. Until issue #33 was fixed, a BUSY driver could set themselves AVAILABLE through driver-service, because driver-service doesn't know about deliveries. The fix keeps the boundary: driver-service still knows nothing about deliveries, but only delivery-service (system token) may move a driver out of BUSY.

### 7. Trade-offs — fine-grained contexts = clear ownership, more integration; coarse contexts = fewer calls, bigger models.
### 8. Performance — chatty boundaries (menu-service asking restaurant-service about ownership on every write) cost a round trip per mutation.
### 9. Security — each context enforces its own authorization; cross-context rules (driver must be on *this* delivery) need data from two contexts.
### 10. Operations — ownership per context lets on-call know who owns an alert.

### 11. Lab
Draw the context map from `services/*/src/common/*.client.ts` (sync calls) and `onModuleInit` subscriptions (async). Compare with the diagram above.

### 12. Verification
Your map has every HTTP client and every Kafka subscription; you spot any arrow the diagram above simplified.

### 13. Interview questions
- *Beginner:* What is a bounded context?
- *Intermediate:* Why do order, delivery and driver each have their own "status"?
- *Advanced:* What is an anticorruption layer, and where does Delivery Plus have one?
- *Senior:* Where are the boundaries of Delivery Plus wrong?

### 14. Senior discussion
Should "driver availability" belong to fulfilment (delivery-service) instead of fleet (driver-service)? What would move, and what would get simpler?

---

## Chapter 3 — Data ownership and cross-service queries

### 1. Why this exists
"Each service owns its data" is easy to say; then the product asks for a screen that needs four services' data.

### 2. Core concept
- **Ownership**: only the owning service writes its tables; others ask it (API) or listen (events).
- **Cross-service queries**: API composition (call several services and join in code), CQRS read models (a dedicated view built from events), or data duplication (snapshot what you need).
- **Shared database anti-pattern**: several services reading/writing the same tables → hidden coupling.

### 3. Mental model
Ask: "Who is the **source of truth** for this fact, and how stale may my copy be?"

### 4. Delivery Plus mapping — **CURRENT**
- No service reads another service's database. Even though all nine databases are on one server with one superuser, the code respects the boundaries.
- **API composition:** `GET /api/users/me/orders` in user-service just proxies to order-service (`services/user-service/src/common/order-service.client.ts`); tracking-service composes delivery + driver + location for `GET /api/tracking/delivery/:id`.
- **Duplication / snapshots:** order items copy names and prices; payments copy `customerId`; deliveries copy `orderId` (no FK).
- **Asking for authorization data:** menu-service asks restaurant-service "is this user the owner?" on every write (`assertOwnership`, `services/menu-service/src/common/restaurant-service.client.ts`); delivery-service asks order-service with the user's token (`assertReadableBy`).
- **No read models** (FUTURE): e.g. a restaurant dashboard view of "orders + delivery status".

### 5. Example — the customer's order screen composes two calls client-side: `GET /api/orders/:id` and `GET /api/deliveries/by-order/:id` (`delivery-plus-customer-app/src/state/orders.ts`, `src/state/deliveries.ts`). The order deliberately does not store a `deliveryId` ([ADR 0006](adrs/0006-no-deliveryid-on-order.md)).

### 6. Failure scenario — API composition fails if *any* source is down: tracking for a delivery needs delivery-, driver- and tracking-service healthy.
### 7. Trade-offs
| Pattern | Freshness | Availability | Complexity |
| --- | --- | --- | --- |
| API composition | live | lowest (all must be up) | low |
| Snapshot on write | frozen | high | low |
| Read model from events | eventual | high | medium-high |

### 8. Performance — composition latency = slowest call (if parallel) or the sum (if sequential).
### 9. Security — composed endpoints must authorize every piece (tracking checks delivery ownership through delivery-service with the user's token).
### 10. Operations — read models need rebuild/replay procedures.

### 11. Lab
Design (on paper) a restaurant-dashboard read model: which events feed it, what table, how is it rebuilt? Compare with [Book 27](27-advanced-data-patterns.md).

### 12. Verification
Your design lists the exact event types from [Book 07 Ch. 11](07-kafka.md#chapter-11--kafka-in-delivery-plus-complete-reference) and handles redelivery.

### 13. Interview questions
- *Beginner:* Why shouldn't services share a database?
- *Intermediate:* API composition vs read model?
- *Advanced:* How do you join data from two services for a report?
- *Senior:* Delivery Plus shares one PostgreSQL server. Is that a "shared database"?

### 14. Senior discussion
menu-service calls restaurant-service for ownership on every mutation (the client comment notes it should become cached/event-driven). Cache it, replicate ownership via events, or put the owner ID in the JWT?

---

## Chapter 4 — Integration: gateway, synchronous calls, events and contracts

### 1. Why this exists
Services must talk to clients and to each other; each style has failure and coupling consequences.

### 2. Core concept
- **API gateway**: single entry point; routing, cross-cutting concerns (CORS, auth, rate limits, request IDs).
- **Synchronous** calls for queries and commands that need an answer.
- **Asynchronous** events for facts and fan-out.
- **Contracts**: OpenAPI for HTTP, event schemas for Kafka; who owns them, how they evolve.

### 3. Mental model
Synchronous calls create *runtime* coupling (both up now); shared types create *build-time* coupling (both updated together); events create *semantic* coupling (both agree what a fact means).

### 4. Delivery Plus mapping — **CURRENT**
- Gateway: `services/api-gateway/src/main.ts` — routes, CORS, blocks `/internal` paths, aggregates Swagger at `/docs`. It does **not** authenticate, rate-limit or time out (issues #37, #38).
- HTTP contracts: public OpenAPI generated from `services/api-gateway/src/public-openapi.ts` into `docs/openapi/delivery-plus-public.json`, drift-checked in CI.
- Event contracts: TypeScript interfaces in `shared/src/events/` (build-time only).
- Service clients: `services/*/src/common/*-service.client.ts` — plain `fetch`, UUID validation of IDs, typed errors.

### 5. Example — contract ownership: order-service owns `OrderPayload`; notification-service consumes it. A breaking change requires coordinating both — easy in the monorepo, impossible to enforce at runtime.
### 6. Failure scenario — the gateway proxies everything under `/api/users` to user-service; if a new internal route were added under a different prefix, the gateway's `isBlockedInternalRoute` wouldn't block it (it only knows `/internal` and `/api/users/internal`). New internal routes must follow the convention.
### 7. Trade-offs — gateway as a thin proxy (current) keeps logic in services but duplicates cross-cutting concerns in each; a smart gateway centralises them and becomes a critical, shared component.
### 8. Performance — the gateway adds one proxy hop (~1 ms locally).
### 9. Security — route policy at the gateway is defence in depth; services must still authenticate every request.
### 10. Operations — the gateway is the place to measure every client-facing request (latency, status) — currently not instrumented.

### 11. Lab
Read `services/api-gateway/src/route-policy.ts` and its spec; try `curl -i localhost:3000/api/users/internal/users` and `curl -i localhost:3000/internal/users`.

### 12. Verification
Both return 404 from the gateway itself (the request never reaches user-service).

### 13. Interview questions
- *Beginner:* What does an API gateway do?
- *Intermediate:* Build-time vs runtime coupling?
- *Advanced:* Who should own an event contract — producer or consumers?
- *Senior:* Gateway responsibilities for a production Delivery Plus?

### 14. Senior discussion
Should the future driver app and restaurant dashboard use the same gateway and routes, or dedicated backends-for-frontends (BFFs)?

---

## Chapter 5 — Orchestration vs choreography in Delivery Plus

### 1. Why this exists
Multi-step business processes need a coordinator — or a convention.

### 2. Core concept
- **Orchestration**: one component tells each participant what to do next (explicit flow, single place to look).
- **Choreography**: participants react to each other's events (loose coupling, emergent flow).

### 3. Mental model
Orchestration = conductor. Choreography = dancers who know the music.

### 4. Delivery Plus mapping
| Process | Style | Coordinator |
| --- | --- | --- |
| Checkout (order → payment → order status) | orchestration by the **client app**, plus payment-service syncing the order | `delivery-plus-customer-app/src/services/checkout.ts` — **CURRENT** |
| Order status convergence from payments/deliveries | choreography (events) + direct HTTP | **CURRENT** |
| Delivery lifecycle | orchestration by **delivery-service** (it calls order- and driver-service) | **CURRENT** |
| Kitchen (prepare, ready) | manual (restaurant owner API calls; no client yet) | **CURRENT** |
| Dispatch on ready-for-pickup | choreography (delivery-service consumes `order.ready_for_pickup`) | **PLANNED** (#97) |
| Cancellation + refund | none yet | **PLANNED** (#53) |

### 5. Example — automatic dispatch as choreography: order-service doesn't know dispatch exists; it publishes `order.ready_for_pickup`, delivery-service reacts.
### 6. Failure scenario — choreography without visibility: "why wasn't this order dispatched?" requires checking consumer lag, DLQ, idempotency markers and driver availability across services.
### 7. Trade-offs — see [Book 09 Ch. 5](09-distributed-systems.md#chapter-5--distributed-transactions-2pc-and-sagas).
### 8. Performance — orchestrated steps add latency per hop; choreographed steps add queueing delay.
### 9. Security — a client-orchestrated flow can be called out of order by a malicious client; every step must validate state server-side (payment checks `order.status === CREATED`).
### 10. Operations — orchestration gives one place for timeouts and compensation.

### 11. Lab
Trace checkout in the customer app source and in logs; list which steps a malicious client could skip or reorder and what the server does.

### 12. Verification
For each step you name the server-side check that prevents abuse (or note its absence).

### 13. Interview questions
- *Beginner:* Orchestration vs choreography?
- *Intermediate:* Why is client-side orchestration risky?
- *Advanced:* When does choreography become unmanageable?
- *Senior:* Choose the style for cancellation + refund + driver release.

### 14. Senior discussion
Should Delivery Plus introduce a workflow engine (Temporal, Step Functions) before or after adding cancellation compensation?

---

## Chapter 6 — Challenging the current boundaries

### 1. Why this exists
Boundaries chosen early encode guesses. Senior engineers revisit them with evidence.

### 2. Core concept — signs of a wrong boundary
- Every feature changes both services.
- Chatty synchronous calls on every request.
- Invariants that span both services can't be enforced in either.
- One service is a thin wrapper around the other's data.

### 3. Mental model
Merge what changes together; split what scales, deploys or is owned differently.

### 4. Delivery Plus mapping — questions worth asking (not decisions)
| Pair | Evidence for merging | Evidence for keeping separate |
| --- | --- | --- |
| auth + user | profile created synchronously at registration (HMAC call); email duplicated in both | credentials are security-critical and small; profiles grow (avatars, addresses) |
| restaurant + menu | menu asks restaurant for ownership on every write; both edited by the same owner UI | menu is read-heavy and cached; restaurant may gain hours/policies |
| delivery + driver | availability vs assignment invariant spans both (#33); delivery calls driver on every action | fleet management (shifts, vehicles, documents) is a growing domain |
| tracking + delivery | tracking calls delivery and driver for every read | location ingestion scales very differently (high-frequency writes) |
| cart + order | order reads cart then clears it via HTTP | cart is Redis-only and ephemeral; order is durable |

### 5. Example — "delivery + driver" is the strongest merge candidate *for the invariant* (a busy driver must have exactly one active delivery). An alternative that keeps services separate: delivery-service becomes the only writer of BUSY/AVAILABLE, and drivers lose the ability to set AVAILABLE themselves while assigned.
### 6. Failure scenario — merging services without merging databases first leaves the same distributed invariant problem inside one codebase.
### 7. Trade-offs — merges reduce network hops and inconsistency; splits enable independent scaling and ownership. Both are expensive to reverse.
### 8. Performance — tracking-service is the one service whose write rate will dwarf all others; it is the best candidate to stay separate.
### 9. Security — auth staying separate keeps the credential database isolated (once least-privilege roles exist).
### 10. Operations — fewer services = fewer pipelines, dashboards and on-call surfaces.

### 11. Lab
Write a one-page ADR (use `docs/adr/adr-template.md`) proposing *one* boundary change, with evidence from the code. See [adrs/](adrs/README.md) for examples.

### 12. Verification
Your ADR cites at least three concrete code locations and states what would get worse.

### 13. Interview questions
- *Senior:* How do you know a service boundary is wrong?
- *Senior:* How do you merge two services with live traffic?
- *Senior:* What evidence would you gather before splitting tracking into ingestion and query services?

### 14. Senior discussion
If Delivery Plus were rebuilt as a modular monolith with the same module boundaries, which of the problems in this library would disappear, and which would remain?

---

[Library index](README.md) · Previous: [Book 09](09-distributed-systems.md) · Next: [Book 11 — NestJS / TypeScript Backend Engineering](11-nestjs-typescript-backend.md)
