# Case Study 10 — Order-to-Delivery Lookup

**Status: CURRENT (`GET /api/deliveries/by-order/:orderId`, commit `8f0ecc0`)** · [Case studies](README.md) · Books: [10](../10-microservices-and-domain-design.md), [03](../03-http-apis-and-web.md) · ADR: [0006](../adrs/0006-no-deliveryid-on-order.md)

## Symptom

- The customer app shows an order and needs its delivery: stage, driver, tracking.
- The order has **no `deliveryId`**, and the only delivery read was by delivery ID. The app had no way to find the delivery for the order on screen.

## Root cause

This is a deliberate data-ownership choice:
- delivery-service owns deliveries, and the delivery row stores `orderId`.
- order-service does not know about deliveries.

The *query* the client needed (order → delivery) had no endpoint.

## Options considered

| Option | Cost |
| --- | --- |
| Add `deliveryId` to the order (written by a delivery event or HTTP call) | order-service gains a dependency on delivery state; one more field to keep in sync; it's wrong while the event is in flight |
| Client lists deliveries and filters | leaks other deliveries; no such list endpoint for customers |
| **`GET /deliveries/by-order/:orderId` in delivery-service** | one extra request from the client; ownership checked by asking order-service |
| A backend-for-frontend that joins order + delivery | a new service to run |

## Fix

- `DeliveriesController.getByOrderId` → `DeliveriesService.getByOrderId(orderId, reader)` applies the same read rules as `getById` ([case study 02](02-delivery-ownership-bug.md)).
- A missing delivery is a normal state ("not dispatched yet"). The backend answers **404**, and `fetchDeliveryForOrder` in `delivery-plus-customer-app/src/services/deliveries.ts` maps that 404 to `null`. That is safe only because the app asks about orders it has already loaded: 404 also means "no such order".

## Tests

- `deliveries.service.spec.ts`: by-order ownership per role.
- Customer app: `delivery-plus-customer-app/src/state/deliveries.test.ts` ("resolves the delivery through the authenticated by-order route").

## Trade-offs

- Two round trips to render an order screen (order, then delivery), each polled every 10 s while active ([case study 11](11-customer-delivery-polling.md)).
- "The delivery for an order" is well-defined because the entity declares `@Index({ unique: true })` on `orderId` (`services/delivery-service/src/entities/delivery.entity.ts`): the database, not just the service, enforces one delivery per order ([SEC-01](../labs/security-labs.md#sec-01-status-code-tour) expects 409 for a second one).

## What can still go wrong

- If re-delivery is ever supported (a second attempt after a cancelled delivery), "the" delivery for an order becomes "the latest", and the endpoint's contract must say so.

## What a senior engineer would ask

1. Is "order has no deliveryId" still right once the driver app (#99) and the "current delivery" contract (#96) exist?
2. Where should a join live: client, BFF, or a read model built from events ([Book 27](../27-advanced-data-patterns.md))?
3. What status code for "no delivery yet": 404, 200 with `null`, or 204? What does each do to client code?
