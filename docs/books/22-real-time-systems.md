# Book 22 — Real-Time Systems

[Library index](README.md) · Previous: [Book 21](21-performance-engineering.md) · Next: [Book 23 — Geo / Location Systems](23-geo-location-systems.md)

**Level:** Advanced · **Prerequisites:** [Book 03 Ch. 8](03-http-apis-and-web.md#chapter-8--requestresponse-vs-events-vs-streaming-connections), [Book 06](06-redis.md), [Book 07](07-kafka.md), [Book 16](16-networking.md).

**Where Delivery Plus is today:**
- **CURRENT:** the customer app polls `GET /api/deliveries/by-order/:orderId` every 10 s while a delivery is active (`delivery-plus-customer-app/src/state/deliveries.ts`, `ACTIVE_DELIVERY_POLL_MS`) and stops when it is terminal.
- **CURRENT:** tracking-service stores the driver's last location in Redis for 300 s (`POST /api/tracking/location`) and serves `GET /api/tracking/delivery/:deliveryId`, but **no client calls either yet** — there is no driver app to send locations, and the customer app doesn't show a map.
- **PLANNED/FUTURE:** WebSocket/SSE tracking (Phase 7 milestone), after the driver app (#99) produces locations. See [case study 12](case-studies/12-future-websocket-tracking.md) and [ADR 0005](adrs/0005-polling-before-websockets.md).

---

## Chapter 1 — Polling, long polling, SSE and WebSockets

### 1. Why this exists
Users expect to see a driver move on the map and a status change within seconds, without pressing refresh.

### 2. Core concept
| Technique | Direction | Latency | Server state | Infra fit |
| --- | --- | --- | --- | --- |
| Polling | client → server | ≤ interval | none | any HTTP stack |
| Long polling | held request | ~instant | one pending request per client | any HTTP stack; timeouts tuning |
| SSE | server → client stream over HTTP | ~instant | one open response per client | HTTP/1.1 & HTTP/2; auto-reconnect built in |
| WebSocket | full duplex | ~instant | one socket per client | needs upgrade support in every proxy/LB |

### 3. Mental model — polling asks "anything new?" on a timer; push says "here's what's new" when it happens.

### 4. Delivery Plus mapping — polling (CURRENT) for delivery status; nothing pushes today.
### 5. Example — cost of polling for 10,000 active deliveries at 10 s: ~1,000 req/s, each touching delivery-service and (via order ownership check) order-service. With push: 10,000 idle connections and only real updates.
### 6. Failure scenario — shortening the poll interval to 1 s "for real-time": 10× load across gateway, delivery-service and order-service, plus battery drain on phones.
### 7. Trade-offs — polling is the right answer for low-frequency state changes (order status); push becomes worthwhile for high-frequency data (driver location every few seconds).
### 8. Performance — see the example; also head-of-line and reconnect storms for push.
### 9. Security — every model needs authentication; push needs re-authorization on reconnect and token expiry handling.
### 10. Operations — push introduces long-lived connections, which change deploys, load balancing and capacity planning.

### 11. Lab — [OPS-14 Measure polling load](labs/devops-labs.md#ops-14-measure-polling-load).
### 12. Verification — you compute requests/second for N active deliveries and compare with your measurement on the dev stack.

### 13. Interview questions
- *Beginner:* Polling vs WebSockets?
- *Intermediate:* When is SSE enough?
- *Advanced:* Why does long polling stress proxies?
- *Senior:* What evidence would justify moving tracking to WebSockets?

### 14. Senior discussion
Order status changes a handful of times per order; driver location changes every few seconds. Should they use the same delivery mechanism?

---

## Chapter 2 — Connection management: heartbeats, reconnects and authentication

### 1. Why this exists
Mobile connections die silently, servers restart, tokens expire.

### 2. Core concept
- **Heartbeats** (ping/pong) detect dead connections and keep NAT/LB idle timers alive.
- **Reconnect with exponential backoff + jitter** to avoid thundering herds after a server restart.
- **Resume**: on reconnect, fetch the current state (or events since a cursor) — never assume nothing was missed.
- **Auth**: authenticate on connect (token in the first message or a short-lived ticket), re-authorize per subscription (may this user watch delivery X?), handle token expiry (1 h JWTs here).

### 3. Mental model — a real-time connection is an optimisation; correctness must come from the snapshot you fetch on (re)connect.

### 4. Delivery Plus mapping — **FUTURE**. The customer app already has the pieces for "snapshot on reconnect": the resource cache revalidates on focus/poll (`delivery-plus-customer-app/src/hooks/use-resource.ts`). Authorization for "watch delivery X" can reuse `GET /api/tracking/delivery/:id`'s rule (delivery ownership via delivery-service with the user's token).
### 5. Example — reconnect sequence:
```text
connect(ticket) → server verifies → subscribe(delivery 123) → server checks ownership → send snapshot → stream updates
on drop: wait 1s·2^n ± jitter → reconnect → subscribe → snapshot → stream
```
### 6. Failure scenario — 50,000 drivers reconnect at the same second after a deploy (no jitter) → the auth path and Redis are hammered → reconnects fail → they retry → outage.
### 7. Trade-offs — tokens in query strings leak into logs; first-message auth needs a short unauthenticated window.
### 8. Performance — heartbeat interval × connections = baseline traffic.
### 9. Security — check authorization per subscription, not only at connect.
### 10. Operations — drain connections gradually during deploys.

### 11. Lab — design the message protocol (JSON types) for tracking: `subscribe`, `snapshot`, `location`, `status`, `error`, `ping/pong`.
### 12. Verification — your protocol handles reconnect without missing a status change.

### 13. Interview questions
- *Beginner:* Why heartbeats?
- *Intermediate:* Why jitter on reconnect?
- *Advanced:* How do you handle a JWT expiring mid-connection?
- *Senior:* Authentication design for WebSockets in Delivery Plus.

### 14. Senior discussion
Should the WebSocket server be a new service, part of tracking-service, or part of the gateway?

---

## Chapter 3 — Fan-out, pub/sub, presence and backpressure

### 1. Why this exists
One driver's location update must reach the right subscribers — the customer, perhaps the restaurant, support — on whichever server holds their connection.

### 2. Core concept
- **Fan-out**: one message → many recipients.
- **Pub/Sub across servers**: Redis Pub/Sub, Redis Streams, Kafka, NATS — so server A can deliver to a client connected to server B.
- **Presence**: who is online (TTL'd keys).
- **Backpressure**: slow clients must not buffer unbounded data on the server; drop or coalesce (only the latest location matters).

### 3. Mental model
```text
driver app ─► tracking-service ─► Redis SET driver:location:{id} (TTL 300 s)   (CURRENT)
                               └─► PUBLISH delivery:{deliveryId} {lat,lng}       (FUTURE)
WebSocket servers A, B, C: SUBSCRIBE to channels of their connected clients → push to sockets
```

### 4. Delivery Plus mapping — **CURRENT:** last-known location with TTL (a presence-like signal). **FUTURE:** publish on update; coalesce per delivery (send latest at most every N seconds).
### 5. Example — Redis Pub/Sub for live locations (loss is fine: the next update replaces it); Kafka `delivery.events` for status changes (must not be lost). Two mechanisms for two kinds of data.
### 6. Failure scenario — using Kafka for every location point with a durable consumer per WebSocket server: huge write volume for data nobody needs after 5 seconds.
### 7. Trade-offs — see Chapter 4.
### 8. Performance — coalescing reduces fan-out traffic by orders of magnitude.
### 9. Security — channel names must not be guessable *and* subscriptions must be authorized server-side.
### 10. Operations — monitor per-server connection counts, publish rates, dropped messages.

### 11. Lab — [RD-08 Pub/Sub vs Streams](labs/redis-labs.md#rd-08-pubsub-vs-streams).
### 12. Verification — you show Pub/Sub loses messages for late subscribers and Streams doesn't.

### 13. Interview questions
- *Beginner:* What is fan-out?
- *Intermediate:* Why do multiple WebSocket servers need a broker?
- *Advanced:* How do you apply backpressure to slow clients?
- *Senior:* Fan-out design for 50k drivers and 200k watchers.

### 14. Senior discussion
Is "latest location wins" (drop intermediate points) acceptable for disputes and analytics? Where would the full trail go?

---

## Chapter 4 — Real-time state vs durable events

### 1. Why this exists
Mixing ephemeral and durable data in one pipeline either loses important events or drowns in unimportant ones.

### 2. Core concept
| | Ephemeral real-time state | Durable events |
| --- | --- | --- |
| Example | driver location now | delivery picked up |
| Loss acceptable? | yes (next update replaces it) | no |
| Store | Redis key with TTL, Pub/Sub | Kafka topic, database |
| Consumers | live UIs | services, notifications, analytics |

### 3. Mental model — "what is true now" vs "what happened".

### 4. Delivery Plus mapping — location is ephemeral (**CURRENT** Redis TTL); delivery lifecycle is durable (**CURRENT** Kafka `delivery.events` + PostgreSQL). Good separation already.
### 5. Example — the customer screen would combine both: status from durable state (snapshot + events), position from ephemeral stream.
### 6. Failure scenario — deriving "picked up" from a geofence on ephemeral location points without a durable event: a lost point means the status never changes.
### 7. Trade-offs — durable everything is expensive; ephemeral everything is unreliable.
### 8. Performance — ephemeral paths can be very high volume.
### 9. Security — ephemeral location still needs retention rules (TTL is one).
### 10. Operations — different SLOs: status freshness (seconds), location freshness (best effort).

### 11. Lab — classify every field the future tracking screen shows as ephemeral or durable, and name its source.
### 12. Verification — no durable decision depends only on ephemeral data.

### 13. Interview questions
- *Senior:* Where should geofence-derived events (arrived at restaurant) be produced, and from what data? (Issue #60.)

### 14. Senior discussion
Should the customer app still poll status as a safety net when WebSockets are added?

---

## Chapter 5 — Scaling connections: sticky sessions and horizontal scaling

### 1. Why this exists
A single server holds tens of thousands of connections at most; beyond that you need many servers and a way to route.

### 2. Core concept — L4/L7 load balancers with WebSocket support, connection limits per pod (file descriptors, memory), sticky sessions (only needed if server-side session state isn't shared), graceful drain on deploy, autoscaling on connection count.
### 3. Mental model — make WebSocket servers stateless except for their live sockets; all routing state lives in the broker.
### 4. Delivery Plus mapping — **FUTURE** design for Phase 7: a `realtime` service (or a module of tracking-service), Redis Pub/Sub for fan-out, gateway/ingress with WebSocket upgrade support, authorization through delivery ownership.
### 5. Example — capacity: 200k concurrent watchers ÷ 20k per pod = 10 pods + headroom; each pod subscribes only to channels of its own clients.
### 6. Failure scenario — deploy restarts all pods at once → 200k reconnects at the same moment.
### 7. Trade-offs — managed real-time services (Ably, Pusher, API Gateway WebSockets) vs self-hosted.
### 8. Performance — memory per connection (tens of KB) dominates.
### 9. Security — DoS by opening many connections: limit per user/IP.
### 10. Operations — rolling restarts with drain, connection-count dashboards.

### 11. Lab — estimate memory for 200k connections at 30 KB each, and fds needed per pod.
### 12. Verification — you also compute the reconnect rate during a rolling deploy of 10 pods.

### 13. Interview questions
- *Senior:* Do you need sticky sessions for WebSockets? When?
- *Senior:* Build vs buy for real-time delivery tracking?

### 14. Senior discussion
At current scale (no driver app yet), what is the minimum real-time architecture that wouldn't need to be thrown away later?

---

[Library index](README.md) · Previous: [Book 21](21-performance-engineering.md) · Next: [Book 23 — Geo / Location Systems](23-geo-location-systems.md)
