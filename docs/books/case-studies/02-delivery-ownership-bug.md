# Case Study 02 — Delivery Ownership Bug

**Status: CURRENT (fixed in commit `8f0ecc0`)** · [Case studies](README.md) · Books: [17](../17-security-engineering.md), [10](../10-microservices-and-domain-design.md) · Lab: [SEC-07](../labs/security-labs.md#sec-07-reproduce-a-bola-check) · ADR: [0009](../adrs/0009-delivery-ownership-enforcement.md)

## Symptom

1. Any signed-in user could `GET /api/deliveries/:id` for **any** delivery and see its order ID, driver ID and status.
2. Any `RESTAURANT_OWNER` could create, assign or cancel a delivery for **any** restaurant's order.

## Root cause

**Reads.** `DeliveriesService.getById(id)` simply returned the row:
```ts
async getById(id: string): Promise<Delivery> {
  return this.findOrThrow(id);
}
```

**Dispatch.** Create, assign and cancel only checked the caller's **role**: `assertDispatchRole(user.role)`. They never checked the relationship between the caller and the order.

This is broken object-level authorization (BOLA/IDOR). The JWT says *who* you are and *what kind* of user you are, but not *which objects* are yours.

## Why the naive version looked reasonable

- Delivery IDs are UUIDs, which are hard to guess.
- Every route was behind `JwtAuthGuard`, and role guards looked like "authorization".
- delivery-service has no `customerId` or `restaurantId` column, so the data needed for an ownership check is not local. Skipping the check was the path of least resistance.

## Impact

- **Information disclosure:** someone else's delivery status and the driver assignment.
- **Integrity:** a competitor restaurant owner could cancel or reassign another restaurant's deliveries.
- UUIDs leak through URLs, logs, screenshots and notifications, so "hard to guess" is not a control.

## Fix

The ownership chain is checked on every read and every dispatch (`services/delivery-service/src/services/deliveries.service.ts`):

| Caller | Read | Dispatch (create/assign/cancel) |
| --- | --- | --- |
| ADMIN | yes | yes |
| DRIVER | only if `delivery.driverId` resolves to the caller's user ID | no |
| CUSTOMER / RESTAURANT_OWNER | order-service is asked with **the caller's own token**: `orderClient.assertReadableBy(orderId, authHeader)` | owner only, through the same check |

- order-service already knows who may read an order (its customer and that restaurant's owner). delivery-service **delegates** the decision instead of copying ownership data.
- `GET /api/deliveries/by-order/:orderId` was added with the same checks ([case study 10](10-order-to-delivery-lookup.md)).

## Tests

- `services/delivery-service/src/services/deliveries.service.spec.ts`: each role × read/dispatch, wrong driver, and the owner of another restaurant.
- Live: [SEC-07](../labs/security-labs.md#sec-07-reproduce-a-bola-check) expects 403 for a second customer on order, delivery, by-order, tracking and payment.

## Trade-offs

- **Every read costs an extra HTTP call** to order-service (and to driver-service for drivers). The gain is a single source of truth for ownership.
- **Availability coupling:** if order-service is down, delivery reads fail closed (an error), not open.
- Forwarding the caller's token works today because all services share `JWT_SECRET` ([case study 18](18-system-token.md)).

## What can still go wrong

- A new route that forgets the check. There is no framework-level "every handler must declare an ownership policy".
- Ownership is checked per request, but the result is not cached. The design is fine; a cache would be the risk if someone adds one with a long TTL.
- The tracking route `/api/tracking/delivery/:id` relies on delivery-service's check. If that check regresses, tracking regresses with it.

## What a senior engineer would ask

1. Which other services return objects by ID without an ownership check? How would you find them systematically (route inventory, tests per role)?
2. Should the delivery row store `customerId` and `restaurantId` to avoid the extra call? What consistency problem would that introduce?
3. Why is "404 vs 403" a design decision? Notifications chose 404 ([case study 04](04-notification-ownership.md)); deliveries return 403. Which is right, and why?
4. What test would *fail* if someone deleted `assertCanRead`?
