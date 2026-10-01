# Case Study 12 — Future WebSocket Tracking

**Status: FUTURE (design exercise; nothing here exists in the code)** · [Case studies](README.md) · Books: [22](../22-real-time-systems.md), [24](../24-system-design.md) · ADR: [0005](../adrs/0005-polling-before-websockets.md)

## The problem to solve

When the driver app (#99) sends locations, customers will want a **moving pin**, which needs updates every few seconds. Polling every 2 s per customer is wasteful ([case study 11](11-customer-delivery-polling.md)).

## What exists today (CURRENT)

- `POST /api/tracking/location`: the driver writes `driver:location:{userId}` in Redis with a 300 s TTL.
- `GET /api/tracking/delivery/:id`: the customer reads it, with ownership checked through delivery-service.
- `delivery.events` on Kafka for status changes.
- No service holds client connections. The gateway proxies HTTP with no upgrade handling configured.

## A design (FUTURE)

```text
driver app ─POST location─▶ tracking-service ─▶ Redis (latest)  ─▶ PUBLISH loc:{deliveryId}
                                                                     │
customer app ◀──WS── realtime-gateway (new) ◀──SUBSCRIBE loc:{deliveryId}──┘
                       ▲
                       └── consumes delivery.events → pushes status changes
```
1. **Connection.** The client opens `wss://…/realtime` with its JWT, then subscribes to `delivery:{id}`. The server checks ownership **once at subscribe time**, using the same rule as today's tracking read.
2. **Fan-out.** tracking-service publishes each location to a Redis Pub/Sub channel per delivery. Every realtime node subscribes to the channels its clients care about. Pub/Sub is fine here because a missed location is replaced seconds later ([RD-08](../labs/redis-labs.md#rd-08-pubsub-vs-streams)).
3. **Status changes.** The realtime service consumes `delivery.events` and pushes them. These are *not* lossy-tolerant, so on reconnect the client re-fetches state over HTTP.
4. **Reconnect.** Exponential backoff with jitter. On reconnect: fetch the current state over REST, then resubscribe. Missed messages are covered by the fetch, not by replay.
5. **Fallback.** If WS fails, fall back to the current polling. This keeps the app working behind proxies that block WebSockets.

## Hard parts

- **Scaling connections.** Each node holds tens of thousands of sockets. Load balancers need sticky or WS-aware routing, and deploys drop connections (graceful drain, #7).
- **Auth expiry** mid-connection (JWT TTL is 1 h): the server must close or ask for a refresh.
- **Ordering:** a status push and a location push can race. The client should apply them by timestamp or version.
- **Backpressure:** slow mobile clients; drop stale locations rather than queueing.
- **Privacy:** stop streaming the driver's location after delivery completes.

## Alternatives

| Option | When it fits |
| --- | --- |
| Server-Sent Events | one-way server → client, simpler over HTTP/2; good for status + location |
| Long polling | few clients, no infrastructure |
| Managed push (Firebase, Ably…) | small team, no realtime infrastructure to run |
| Mobile push notifications | status changes when the app is closed (not live pins) |

## What a senior engineer would ask

1. Do we need WebSockets (bidirectional) or would SSE do?
2. What is the *minimum* change that delivers a moving pin for the first 1,000 users?
3. How do you load-test 50,000 concurrent sockets, and what metric tells you a node is full?
4. Which guarantees does the customer actually need: every location, or the latest one?
