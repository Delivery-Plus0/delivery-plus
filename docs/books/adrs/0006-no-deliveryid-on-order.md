# ADR 0006 — No `deliveryId` on the Order

**Status:** Accepted (reconstructed teaching ADR) · [ADRs](README.md) · Book: [10](../10-microservices-and-domain-design.md) · Case study: [10](../case-studies/10-order-to-delivery-lookup.md)

## Context

- An order and its delivery are owned by different services, each with its own database (`order_service`, `delivery_service`).
- The relationship is one-to-one. The delivery row has a unique `orderId`.

## Decision

- The order does **not** store `deliveryId`.
- Clients find a delivery through `GET /api/deliveries/by-order/:orderId` in delivery-service, which checks access by asking order-service.

## Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| `deliveryId` on order, set via HTTP from delivery-service | order-service knows about deliveries; another sync that can fail and must be retried |
| `deliveryId` on order, set from `delivery.created` event | eventually consistent; the client sees an order "without delivery" briefly anyway |
| embed delivery status in the order | two services own the same status; conflicts |

## Consequences

**Good**
- Each fact lives in one place.
- order-service has no knowledge of delivery internals.
- A unique index enforces the one-to-one relationship.

**Costs**
- The client makes two requests per order screen.
- "No delivery yet" is a 404 that the client maps to `null` ([case study 10](../case-studies/10-order-to-delivery-lookup.md)).

**Revisit when** a backend-for-frontend or read model (order + delivery view built from events) is introduced, or deliveries become one-to-many (re-delivery attempts).
