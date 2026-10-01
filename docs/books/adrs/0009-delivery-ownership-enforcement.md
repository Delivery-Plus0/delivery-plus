# ADR 0009 — Delivery Ownership Enforcement

**Status:** Accepted (reconstructed from commit `8f0ecc0`) · [ADRs](README.md) · Book: [17](../17-security-engineering.md) · Case study: [02](../case-studies/02-delivery-ownership-bug.md) · Lab: [SEC-07](../labs/security-labs.md#sec-07-reproduce-a-bola-check)

## Context

- delivery-service stores `orderId` and `driverId`, but not `customerId` or `restaurantId`.
- Who may read or dispatch a delivery depends on facts owned by order-service (customer, restaurant owner) and driver-service (which user a driver is).

## Decision

- **Reads:**
  - ADMIN can read any delivery.
  - A DRIVER can read only if the delivery's driver resolves to their user ID.
  - CUSTOMER and RESTAURANT_OWNER are checked by **asking order-service with the caller's own token** (`orderClient.assertReadableBy`).
- **Dispatch** (create, assign, cancel): ADMIN, or a RESTAURANT_OWNER who passes the same order check.
- Tracking reads for customers go through delivery ownership.

## Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| copy `customerId`/`restaurantId` onto the delivery | local check, no extra call; duplicated data that must stay in sync (e.g. restaurant ownership changes) |
| central authorization service (policy engine) | consistent policies; a new critical dependency |
| gateway-level checks | gateway would need domain knowledge |
| signed capability in the order response | no extra call; complex, short-lived tokens |

## Consequences

**Good**
- One source of truth for "who owns this order".
- The check can't drift from order-service's rules.

**Costs**
- An extra HTTP call per read, plus one to driver-service for drivers.
- Reads fail if order-service is down (fail closed).
- Forwarding user tokens relies on a shared `JWT_SECRET` ([case study 18](../case-studies/18-system-token.md)).

**Revisit when** read volume makes the extra call expensive (polling at scale), or a central policy service is introduced.
