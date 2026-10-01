# Case Study 19 — Driver Dispatch

**Status: PARTIAL (manual dispatch CURRENT; automatic dispatch PLANNED in [#97](https://github.com/Yousefa7medmaher/delivery-plus/issues/97))** · [Case studies](README.md) · Books: [23](../23-geo-location-systems.md), [24](../24-system-design.md) · Lab: [GEO-07](../labs/geo-and-algorithms-labs.md#geo-07-greedy-vs-batch-assignment)

## How dispatch works today (CURRENT)

1. The order reaches `READY_FOR_PICKUP` (the restaurant owner moves it).
2. The **restaurant owner or an admin** calls `POST /api/deliveries` (create), then `POST /api/deliveries/:id/assign`.
3. `assignDriver` (`services/delivery-service/src/services/deliveries.service.ts`):
   - asks driver-service for an available driver (`findAvailableDriver`);
   - marks that driver BUSY;
   - records the assignment with compare-and-set;
   - gives the driver back if recording fails.
4. driver-service's `findAvailable` orders AVAILABLE drivers by **`updatedAt DESC`** (`services/driver-service/src/repositories/drivers.repository.ts`), and the first one is chosen.

So the algorithm is: **the most recently updated available driver**. Location plays no part.

## Problems

| Problem | Effect |
| --- | --- |
| no location input | a driver 20 km away can be picked over one next door |
| "most recently updated" | the driver who just came online or just finished gets the job; drivers who waited longest get nothing (unfair) |
| a human must press "assign" | orders wait whenever the restaurant is busy (#97) |
| no driver accept or decline | a driver can't refuse; no timeout or reassignment |
| no address on the order | even with driver locations there is no drop-off point (#95) |
| claim race (**fixed, #33**) | two concurrent assigns can pick the **same** first driver. The BUSY claim used to be a blind write, so both could "succeed". It is now compare-and-set: exactly one claim wins, and the loser tries the next available driver |

## What already helps

- Retry-safe assign and give-back ([case study 09](09-driver-availability-lifecycle.md)).
- Driver locations exist: `driver:location:{userId}` in Redis with a 300 s TTL (tracking-service), but dispatch does not read them.

## A path forward

1. ~~**Atomic claim** in driver-service~~: **done for #33.** `transitionStatus` runs `UPDATE … WHERE id = $1 AND status = 'AVAILABLE'`, and `claimAvailableDriver` tries the next driver on a lost claim.
2. **Automatic dispatch** (#97): consume `order.ready_for_pickup` (or poll), create and assign. It must be idempotent per order.
3. **Nearest available driver** ([case study 20](20-nearest-driver-search.md)) once orders have coordinates (#95).
4. **Offer, accept or timeout** with the driver app (#99).
5. **Batch assignment** when volume is high ([GEO-07](../labs/geo-and-algorithms-labs.md#geo-07-greedy-vs-batch-assignment)): greedy-nearest is locally good and globally poor.

## What a senior engineer would ask

1. What does "best driver" mean here: closest, fairest, or fastest overall? Who decides?
2. Show me the race between two concurrent assigns and the test that proves the fix.
3. What happens when no driver is available: retry, queue, or tell the restaurant?
4. Which part of dispatch should be synchronous, and which event-driven?
