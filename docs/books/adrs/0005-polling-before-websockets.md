# ADR 0005 — Polling Before WebSockets

**Status:** Accepted (reconstructed teaching ADR) · [ADRs](README.md) · Books: [22](../22-real-time-systems.md), [21](../21-performance-engineering.md) · Case studies: [11](../case-studies/11-customer-delivery-polling.md), [12](../case-studies/12-future-websocket-tracking.md)

## Context

- Customers want to see order progress.
- Status changes every few minutes, and live driver location isn't sent by any client yet (no driver app, #99).
- The platform has no component that holds client connections, and the gateway is a plain HTTP proxy.

## Decision

The customer app polls:
- the order and its delivery every **10 s** while they are active;
- notifications every **60 s**.

Polling stops at terminal states (`delivery-plus-customer-app/src/state/orders.ts`, `src/state/deliveries.ts`, `src/hooks/use-resource.ts`).

## Alternatives considered

| Alternative | Why not yet |
| --- | --- |
| WebSockets | new stateful service, auth on long connections, LB and deploy concerns; little benefit for minute-scale changes |
| Server-Sent Events | simpler than WS; still needs a connection-holding service and event fan-out |
| push notifications | right for "app closed" updates; not a live screen |
| long polling | ties up gateway connections; complexity for little gain |

## Consequences

**Good**
- Stateless.
- Uses existing auth, rate limits and tests.
- Works through any proxy.

**Costs**
- Up to ~10 s staleness.
- Request volume grows linearly with active orders, mostly "nothing changed" responses.
- Each delivery read costs an ownership call ([case study 11](../case-studies/11-customer-delivery-polling.md) has the arithmetic).

**Revisit when** the driver app sends live locations (a moving pin needs seconds, not tens of seconds), or when polling traffic dominates gateway load.
