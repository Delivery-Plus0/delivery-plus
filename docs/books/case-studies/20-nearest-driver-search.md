# Case Study 20 — Nearest-Driver Search

**Status: FUTURE (design exercise)** · [Case studies](README.md) · Books: [23](../23-geo-location-systems.md), [02](../02-data-structures-and-algorithms.md) · Labs: [GEO-04](../labs/geo-and-algorithms-labs.md#geo-04-haversine-and-bounding-box), [GEO-05](../labs/geo-and-algorithms-labs.md#geo-05-nearest-k-drivers), [RD-06](../labs/redis-labs.md#rd-06-redis-geo-nearest-drivers)

## What exists (CURRENT)

- **Driver location:** `driver:location:{userId}` in Redis (JSON with lat/lng, 300 s TTL), written by `POST /api/tracking/location`.
- **Almost no coordinates.** Restaurants have none. Orders store a text `deliveryAddress` and *optional* client-sent `deliveryLatitude`/`deliveryLongitude` (issue #95), with no geocoding. The only systematic geographic data is driver positions.
- **Dispatch ignores location** ([case study 19](19-driver-dispatch.md)).

## The question

"Find the K nearest AVAILABLE drivers to this restaurant, within R km, whose location is fresh."

## Approaches

| Approach | Query cost | Notes |
| --- | --- | --- |
| scan all available drivers, compute haversine, sort | O(n log n) per request | fine for hundreds of drivers; [GEO-05](../labs/geo-and-algorithms-labs.md#geo-05-nearest-k-drivers) measures it |
| bounding box prefilter, then haversine | O(n) cheap filter + small sort | [GEO-04](../labs/geo-and-algorithms-labs.md#geo-04-haversine-and-bounding-box) |
| **Redis GEO** (`GEOADD drivers:available`, `GEOSEARCH … BYRADIUS … ASC COUNT K`) | O(log n + m) | geohash-sorted set; [RD-06](../labs/redis-labs.md#rd-06-redis-geo-nearest-drivers) |
| PostGIS (`ST_DWithin` + GiST index) | index scan | needs location in PostgreSQL; better for history and analytics than hot positions |
| H3 / S2 cells | O(1) cell lookup + ring expansion | good for supply/demand per area and surge pricing |

## Design sketch with Redis GEO (FUTURE)

- On a location update, `GEOADD drivers:available <lng> <lat> <driverId>`, but only while the driver is AVAILABLE. On BUSY or OFFLINE, `ZREM`.
- **Staleness:** GEO members don't expire individually. Keep a `driver:seen:{id}` key with a TTL, or store last-seen in a sorted set, and drop stale results.
- **Consistency:** status lives in PostgreSQL (driver-service) and position in Redis. A driver can be in the GEO set while already BUSY. Treat the search result as **candidates**, then claim atomically ([case study 19](19-driver-dispatch.md)).
- Straight-line distance ≠ travel time. Rank candidates by **ETA** from a routing service for the final choice ([GEO-06](../labs/geo-and-algorithms-labs.md#geo-06-dijkstra-vs-a-on-a-grid)).

## What can still go wrong

- GPS jitter and spoofing. Validate speed between updates ([GEO-08](../labs/geo-and-algorithms-labs.md#geo-08-geofence-with-hysteresis)).
- City boundaries, rivers and bridges make "nearest" misleading.
- Hot spots: everyone near a mall gets every order.

## What a senior engineer would ask

1. How many drivers per city, now and in 2 years? Does a full scan already suffice?
2. Where do restaurant and customer coordinates come from (geocoding, #95), and how accurate are they?
3. Candidate search then atomic claim: what's the retry policy when the claim loses?
4. What metric proves the new dispatch is better than "most recently updated"?
