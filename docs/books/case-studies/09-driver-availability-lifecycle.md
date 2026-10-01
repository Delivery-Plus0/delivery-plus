# Case Study 09 — Driver Availability Lifecycle

**Status: PARTIAL (release made retry-safe in `67835d3`; deterministic transitions fixed for [#33](https://github.com/Yousefa7medmaher/delivery-plus/issues/33); drift reconciliation still open)** · [Case studies](README.md) · Books: [09](../09-distributed-systems.md), [10](../10-microservices-and-domain-design.md), [23](../23-geo-location-systems.md) · Lab: [DS-06](../labs/distributed-systems-labs.md#ds-06-repeat-delivery-completion-with-a-service-down)

## The lifecycle

`shared/src/types/enums.ts`:
```text
OFFLINE   → AVAILABLE, SUSPENDED
AVAILABLE → OFFLINE, BUSY, SUSPENDED
BUSY      → AVAILABLE, SUSPENDED
SUSPENDED → OFFLINE
```
- **The driver controls** `OFFLINE ↔ AVAILABLE` through `POST /api/drivers/me/online` and `/me/offline`.
- **delivery-service controls** `AVAILABLE → BUSY` on assignment and `BUSY → AVAILABLE` on completion or cancellation, calling driver-service with a system token.

## Symptom (before the fix)

- A delivery was completed while driver-service was briefly down. The delivery became `DELIVERED`, but the driver stayed **BUSY forever**.
- The retry got 409 (`DELIVERED → DELIVERED`), and nothing else released the driver.
- Cancel, pickup and assign had the same shape.

## Root cause

- The delivery write and the driver release were two steps in two services, with no way to repeat the second.
- The state machine treated "already there" as an error rather than "maybe the side effects didn't finish".

## Why the naive version looked reasonable

- Each call worked, and the transition table was strict.
- Strictness feels safe, but it turns retries into errors.

## Impact

- Drivers silently disappeared from the available pool.
- Dispatch failed with "No available drivers" while drivers were idle.

## Fix (CURRENT)

In `services/delivery-service/src/services/deliveries.service.ts`:
- **Compare-and-set** delivery writes (`transition(id, from, data)`), so concurrent cancel and complete can't both win.
- **Already in the target status → skip the write and re-run the side effects.**
- **Release the driver first** on complete and cancel, independent of order-service. Release is idempotent: a driver who is no longer BUSY counts as released.
- **Never release a driver who has another active delivery** (`releaseDriverOf`).
- **Give back a claimed driver** if recording the assignment fails (`giveBackClaimedDriver`); a retried assign does not claim a second driver.

## Tests

- `deliveries.service.spec.ts`: side-effect failures, then retry, then the driver is released; no release while another delivery is active.
- `driver-service.client.spec.ts`: release is idempotent.
- The fix was verified live on the E2E stack with order-service down and, separately, with driver-service down.

## Fixed for #33

- **A BUSY driver could make themselves AVAILABLE** (`/me/online` or `/me/status`): the role rules only looked at the *target* status, and BUSY → AVAILABLE is a valid transition. Rules are now per *(from → to)* pair (`services/driver-service/src/common/driver-transition-rules.ts`). A DRIVER may only go OFFLINE ↔ AVAILABLE; claim and release are ADMIN-only (delivery-service's system token). A BUSY driver now gets 403.
- **Status updates were a blind write** (read, check, `UPDATE … WHERE id`). Two assignments could both claim one driver, and "go offline" could interleave with a claim. Writes are now compare-and-set (`transitionStatus`), so exactly one wins and the loser gets 409. delivery-service's `claimAvailableDriver` then tries the next driver (up to 3).
- **Repeated requests:** going online/offline twice, or releasing twice, is a no-op. Claiming a BUSY driver is never a no-op.

## What is still open

- There is no "I'm going offline after this delivery" intent: a BUSY driver must wait for the release.
- Nothing **reconciles** drift. A driver who is BUSY with no active delivery stays BUSY until someone notices.
- The location TTL (`driver:location:{userId}`, 300 s) is independent of status: an AVAILABLE driver may have no known location ([case study 19](19-driver-dispatch.md)).

## Trade-offs

- Synchronous release from delivery-service (the owner of "is this driver on a delivery?") instead of an event consumer in driver-service. This gives fewer moving parts and no late-event hazard, but it is coupled to driver-service being up (retries cover it).

## What a senior engineer would ask

1. Which service *owns* driver availability: driver-service, or delivery-service, which knows about active deliveries?
2. Read `transitionStatus` and `DriversService.transition`. Why is a repeated AVAILABLE a no-op but a repeated BUSY a conflict? What does each caller do on `null`?
3. Design a reconciliation job: what query finds drift, and what does it do automatically versus alert on?
4. What should "go offline" mean for a BUSY driver?
