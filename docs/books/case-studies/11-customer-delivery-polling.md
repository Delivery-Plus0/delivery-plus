# Case Study 11 — Customer Delivery Polling

**Status: CURRENT** · [Case studies](README.md) · Books: [22](../22-real-time-systems.md), [21](../21-performance-engineering.md) · ADR: [0005](../adrs/0005-polling-before-websockets.md) · Lab: [E2E-04](../labs/e2e-labs.md#e2e-04-full-business-flow-validation)

## The design

The customer app shows live order progress by **polling**:

| What | Interval | Where |
| --- | --- | --- |
| order (while active) | 10 s | `delivery-plus-customer-app/src/state/orders.ts` (`ACTIVE_ORDER_POLL_MS`) |
| delivery (while order and delivery are active) | 10 s | `delivery-plus-customer-app/src/state/deliveries.ts` (`ACTIVE_DELIVERY_POLL_MS`) |
| notifications badge | 60 s | `delivery-plus-customer-app/src/app/(app)/(tabs)/_layout.tsx` |

`useResource` (`delivery-plus-customer-app/src/hooks/use-resource.ts`):
- revalidates on an interval that can depend on the current data;
- stops polling when the order reaches a terminal state;
- de-duplicates in-flight requests through a shared resource cache (`src/state/resource-cache.ts`).

## Why polling (and not WebSockets) today

- **There is no push channel.** The gateway is an HTTP proxy, and no service holds client connections.
- The data changes in **minutes**. A 10 s delay is acceptable for "preparing → picked up".
- Polling is stateless and works through every proxy. It reuses auth, rate limits and caching, and it's trivial to test. The E2E suite simply waits up to 30 s for the next stage.

## Costs (do the arithmetic)

- One active order means two requests every 10 s, which is 12 per minute per customer.
- 10,000 customers with active orders give ~2,000 requests/s at the gateway, almost all answering "nothing changed".
- Each delivery read also triggers an ownership call to order-service ([case study 02](02-delivery-ownership-bug.md)), so ~3,000 internal requests/s.
- **Worst-case staleness is about 10 s** plus request time. Average ~5 s.

## Symptoms you would see as it grows

- Gateway and order-service CPU dominated by unchanged reads.
- Rate limits hit by legitimate polling if limits are tightened.
- Battery and data use on mobile.

## Cheaper steps before WebSockets

1. **Conditional requests** (`ETag` / `If-None-Match` → 304): less payload, same request count.
2. **Adaptive intervals:** slower while "preparing", faster near hand-off.
3. **Pause when backgrounded.**
4. **Return the delivery with the order** (a BFF or embed): one request instead of two.

## What can still go wrong

- A client bug that never stops polling (a terminal-state check that misses a new status) multiplies load silently.
- Thundering herd: many clients polling in phase after an outage. Jitter helps.

## What a senior engineer would ask

1. At what active-user count does polling cost more than holding connections? Show your numbers.
2. Which screens actually need sub-second updates? (Driver location on a map does; order status doesn't.)
3. If you add WebSockets, what still needs polling as a fallback ([case study 12](12-future-websocket-tracking.md))?
