# Book 23 — Geo / Location Systems

[Library index](README.md) · Previous: [Book 22](22-real-time-systems.md) · Next: [Book 24 — System Design](24-system-design.md)

**Level:** Advanced · **Prerequisites:** [Book 02 Ch. 10–11](02-data-structures-and-algorithms.md#chapter-10--spatial-search-distance-geohash-h3-trees-and-k-nearest-neighbours), [Book 06 Ch. 8](06-redis.md#chapter-8--geospatial-data-and-current-location).

**What exists today:**
- **CURRENT:** drivers can report `{ latitude, longitude }` (validated with `@IsLatitude`/`@IsLongitude`, `services/tracking-service/src/dto/update-location.dto.ts`); the latest point is stored as JSON at `driver:location:{userId}` for 300 s (`LOCATION_TTL_SECONDS`) with a server-side `updatedAt`.
- **NOT PRESENT:** coordinates for restaurants (only a text `address`) or customers (orders carry a text `deliveryAddress` since issue #95; coordinates only when the client sends them, no geocoding), any spatial query, routing, ETA, or geofences. Dispatch picks the most recently updated AVAILABLE driver regardless of distance.

Everything beyond storing the last point is **FUTURE** and taught as design plus local experiments. Labs: [geo-and-algorithms-labs.md](labs/geo-and-algorithms-labs.md).

---

## Chapter 1 — Coordinates and distance

### 1. Why this exists
Every dispatch, ETA and geofence decision starts with "how far?".

### 2. Core concept
- **WGS84** latitude (−90…90) / longitude (−180…180) in decimal degrees — what GPS and maps use.
- One degree of latitude ≈ 111 km; one degree of longitude ≈ 111 km × cos(latitude) (shrinks towards the poles).
- **Haversine**: great-circle distance on a sphere (error ≤ ~0.5% vs the ellipsoid — fine for dispatch).
- **Equirectangular approximation**: faster, accurate for short distances.
- Order matters: many APIs use `lng, lat` (Redis GEO, GeoJSON, PostGIS `ST_MakePoint(lng, lat)`); the Delivery Plus DTO uses named fields.

### 3. Mental model — degrees are not distances; convert before comparing.

### 4. Delivery Plus mapping — coordinates exist only for drivers (CURRENT). Mixing up lat/lng order when moving them into Redis GEO or PostGIS is the classic first bug.
### 5. Example — see `haversineKm` in [Book 02 Ch. 10](02-data-structures-and-algorithms.md#chapter-10--spatial-search-distance-geohash-h3-trees-and-k-nearest-neighbours).
### 6. Failure scenario — Euclidean distance on raw degrees: in Cairo (≈30°N) longitude degrees are ~15% shorter than latitude degrees; "nearest" picks the wrong driver along east–west axes.
### 7. Trade-offs — Haversine vs Vincenty (ellipsoid, more precise, slower) vs approximation; for city-scale dispatch Haversine is plenty.
### 8. Performance — Haversine: a few trigonometric calls (~100 ns).
### 9. Security — precise coordinates are personal data; round them for anything public.
### 10. Operations — validate ranges at ingestion (already done) and reject (0, 0) "null island" points.

### 11. Lab — [GEO-04 Haversine and bounding box](labs/geo-and-algorithms-labs.md#geo-04-haversine-and-bounding-box).
### 12. Verification — your Haversine and the Redis `GEODIST` agree within 0.5%.

### 13. Interview questions
- *Beginner:* Why not subtract lat/lng directly?
- *Intermediate:* What does Haversine compute?
- *Advanced:* When does the spherical approximation matter?
- *Senior:* Coordinate handling contract between apps and backend.

### 14. Senior discussion
Should the backend store coordinates as two floats, a PostGIS geography, a geohash string, or an H3 cell — or several?

---

## Chapter 2 — Radius search, bounding boxes and spatial indexes

### 1. Why this exists
"Drivers within 3 km" over thousands of drivers must avoid computing every distance.

### 2. Core concept
- **Bounding box prefilter**: lat/lng ranges around the point (cheap, index-friendly), then exact distance.
- **Geohash**: a string whose prefixes are nested rectangles; search the cell and its 8 neighbours.
- **H3**: hierarchical hexagons (resolution 0–15); `gridDisk(cell, k)` gives rings of neighbours; uniform adjacency.
- **R-tree / GiST** (PostGIS): bounding-rectangle trees; KNN operator `<->`.
- **KD-tree**: binary space partitioning for points (in-memory).
- **Redis GEO**: sorted set with 52-bit geohash scores; `GEOSEARCH BYRADIUS … ASC COUNT k`.

### 3. Mental model — narrow candidates cheaply, then compute exactly on a few.

### 4. Delivery Plus mapping — **FUTURE**. Natural choice for drivers: Redis GEO (already in the stack, matches TTL'd location data); natural choice for restaurants (static, polygon delivery zones): PostGIS in restaurant-service — both need coordinates that don't exist yet.
### 5. Example
```text
GEOADD drivers:available 31.2357 30.0444 d1 31.2400 30.0500 d2 31.3000 30.1000 d3
GEOSEARCH drivers:available FROMLONLAT 31.24 30.05 BYRADIUS 3 km ASC WITHDIST COUNT 2
```
### 6. Failure scenario — geohash without neighbour cells: a driver 50 m away across a cell edge is invisible.
### 7. Trade-offs
| | Redis GEO | PostGIS | H3 (library) |
| --- | --- | --- | --- |
| Write rate | very high | moderate | n/a (computed) |
| Expiry of stale points | manual removal | queries by time | n/a |
| Polygons / zones | no | yes | approximated by cell sets |
| Aggregation (supply per area) | awkward | SQL | natural |

### 8. Performance — GEOSEARCH O(N+log M); PostGIS KNN with GiST O(log n + k).
### 9. Security — don't expose "all drivers near me" with exact positions to customers.
### 10. Operations — stale entries are the main correctness risk.

### 11. Lab — [RD-06 Redis GEO nearest drivers](labs/redis-labs.md#rd-06-redis-geo-nearest-drivers).
### 12. Verification — results ordered by distance; members beyond the radius excluded.

### 13. Interview questions
- *Beginner:* What is a bounding box prefilter?
- *Intermediate:* How does geohash enable proximity search?
- *Advanced:* Why hexagons in H3?
- *Senior:* Redis GEO vs PostGIS for drivers and for restaurants.

### 14. Senior discussion
Should "available drivers" be a separate GEO set (requires keeping availability in sync with driver-service) or should availability be filtered after a location search?

---

## Chapter 3 — Driver matching, routes and ETA

### 1. Why this exists
Straight-line nearest is not road-nearest; ETA is a promise to the customer.

### 2. Core concept
- **Route distance/time** from a routing engine (OSRM, Valhalla, GraphHopper, Google/Mapbox).
- **ETA** = driver → restaurant travel + preparation remaining + restaurant → customer travel (+ handover buffers).
- **Matching** (Book 02 Ch. 8): greedy vs batch.
- **Correction from history**: actual vs predicted by zone and hour.

### 3. Mental model — use straight-line to shortlist, routing to decide, history to calibrate.

### 4. Delivery Plus mapping — **FUTURE** in full; prerequisites: restaurant coordinates, order delivery address (#95), automatic dispatch (#97), driver app sending locations (#99), and somewhere to keep historical durations (no analytics store exists).
### 5. Example — shortlist 10 drivers by Redis GEO, then one routing "table" request (10 origins × 1 destination), choose the lowest travel time.
### 6. Failure scenario — ETA from straight-line distance across a river: promised 12 min, actual 35 min; refunds and churn.
### 7. Trade-offs — routing API cost per call vs accuracy; cache per (zone pair, hour).
### 8. Performance — one batched matrix call per dispatch instead of N route calls.
### 9. Security — sending customer coordinates to third parties: minimise and document.
### 10. Operations — routing provider outage → fallback to straight-line × detour factor, flagged as low-confidence ETA.

### 11. Lab — [GEO-06 Dijkstra vs A* on a grid](labs/geo-and-algorithms-labs.md#geo-06-dijkstra-vs-a-on-a-grid) and [GEO-07 Greedy vs batch assignment](labs/geo-and-algorithms-labs.md#geo-07-greedy-vs-batch-assignment).
### 12. Verification — you explain where straight-line ranking and route ranking disagree.

### 13. Interview questions
- *Intermediate:* Why not use straight-line distance for ETA?
- *Advanced:* How do you combine preparation time and travel time?
- *Senior:* Design ETA with a fallback strategy.

### 14. Senior discussion
Is a precise ETA worth the cost at launch, or is a range ("25–35 min") the better product?

---

## Chapter 4 — Location update frequency, GPS noise, battery and staleness

### 1. Why this exists
Location data is noisy, expensive to produce, and goes stale.

### 2. Core concept
- **Update frequency**: every 3–10 s while on a delivery, much less when idle; adaptive by speed/state.
- **Noise**: GPS jumps of tens of metres in cities; filter with accuracy thresholds, speed sanity checks (no 300 km/h scooters), smoothing (Kalman filters).
- **Battery**: GPS + radio wake-ups drain phones; batch uploads, use OS significant-change APIs when idle.
- **Staleness**: a point older than N seconds is not "where the driver is".

### 3. Mental model — every location has an age and an accuracy; decisions must consider both.

### 4. Delivery Plus mapping — **CURRENT:** 300 s TTL and server-side `updatedAt`; no accuracy field, no speed checks, no rate limit on `POST /api/tracking/location` beyond JWT. **FUTURE:** accuracy in the DTO, plausibility checks, per-driver rate limit, adaptive frequency in the driver app (#99).
### 5. Example — reject a point implying 400 km/h from the previous one; keep the previous point.
### 6. Failure scenario — a 300 s TTL means a driver whose app crashed still appears "located" for up to 5 minutes; dispatch could choose them. For dispatch, use a much shorter freshness window (e.g. 30 s) than for display.
### 7. Trade-offs — higher frequency = better tracking, more battery, more ingestion load.
### 8. Performance — 50,000 drivers × 1 update / 5 s = 10,000 writes/s — fine for Redis, heavy for PostgreSQL.
### 9. Security — fake GPS apps: trust boundaries for location-derived events (issue #60).
### 10. Operations — monitor update rates and the share of stale drivers.

### 11. Lab — simulate 20 drivers sending noisy updates; implement a speed filter; count rejected points.
### 12. Verification — your filter removes injected jumps without dropping normal movement.

### 13. Interview questions
- *Intermediate:* Why do locations need TTLs?
- *Advanced:* How do you detect GPS spoofing?
- *Senior:* Location ingestion design for battery and accuracy.

### 14. Senior discussion
Should tracking-service store *every* point for a delivery (dispute resolution, ETA training) — and for how long, given privacy?

---

## Chapter 5 — Geofencing

### 1. Why this exists
Automatic "arrived at restaurant / arrived at customer" saves drivers taps and gives the business reliable timestamps.

### 2. Core concept — point-in-circle (distance < r), point-in-polygon (ray casting), H3 cell membership; **hysteresis** (inside for N seconds / entered and exited thresholds) to absorb noise; events derived from server-side state.
### 3. Mental model — a geofence is a state machine fed by noisy inputs.
### 4. Delivery Plus mapping — **FUTURE**; issue #60 frames the trust boundary: geofence events must come from trusted tracking state, never from client claims.
### 5. Example — enter when distance < 80 m for 2 consecutive points ≥ 10 s apart; exit when > 150 m.
### 6. Failure scenario — single-point geofence: GPS jitter at the boundary toggles "arrived/left" many times; each toggle publishes an event.
### 7. Trade-offs — larger radius = earlier detection, more false positives.
### 8. Performance — check only the current delivery's 2 geofences per update, not all restaurants.
### 9. Security — server-side evaluation only.
### 10. Operations — log geofence decisions with the points that caused them.

### 11. Lab — [GEO-08 Geofence with hysteresis](labs/geo-and-algorithms-labs.md#geo-08-geofence-with-hysteresis).
### 12. Verification — a noisy track crossing the boundary produces one enter and one exit, not dozens.

### 13. Interview questions
- *Advanced:* Why hysteresis?
- *Senior:* Should a geofence "arrived" event change the delivery status automatically or only suggest it?

### 14. Senior discussion
Automatic status changes from geofences remove driver taps but add a new writer to the delivery state machine. How do you keep it idempotent and conflict-free with the manual actions?

---

## Chapter 6 — Experiments to run

| Experiment | Question | Lab |
| --- | --- | --- |
| Nearest driver | brute force vs Redis GEO — same answer, how much faster? | [GEO-05](labs/geo-and-algorithms-labs.md#geo-05-nearest-k-drivers), [RD-06](labs/redis-labs.md#rd-06-redis-geo-nearest-drivers) |
| Nearby restaurants | PostGIS or bounding box on a `restaurants` copy with invented coordinates | [GEO-04](labs/geo-and-algorithms-labs.md#geo-04-haversine-and-bounding-box) |
| Pickup geofence | noise vs hysteresis | [GEO-08](labs/geo-and-algorithms-labs.md#geo-08-geofence-with-hysteresis) |
| Driver search optimisation | `ORDER BY "updatedAt"` with and without an index at 100k drivers | [DB-03](labs/database-labs.md#db-03-index-vs-sequential-scan) |
| Dispatch quality | greedy vs batch total distance | [GEO-07](labs/geo-and-algorithms-labs.md#geo-07-greedy-vs-batch-assignment) |

See also [case study 20 — nearest-driver search](case-studies/20-nearest-driver-search.md).

---

[Library index](README.md) · Previous: [Book 22](22-real-time-systems.md) · Next: [Book 24 — System Design](24-system-design.md)
