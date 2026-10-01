# ADR 0003 — Redis for Current Driver Location

**Status:** Accepted (reconstructed teaching ADR) · [ADRs](README.md) · Books: [06](../06-redis.md), [23](../23-geo-location-systems.md) · Case study: [20](../case-studies/20-nearest-driver-search.md)

## Context

- Drivers report their position every few seconds while working.
- Customers need the **latest** position of *their* driver, and nobody needs yesterday's positions yet.
- A stale position is worse than none: the driver's app may have died.

## Decision

tracking-service stores the latest location as JSON at `driver:location:{userId}`, with `SET … EX LOCATION_TTL_SECONDS` (default 300 s) (`services/tracking-service/src/repositories/location.repository.ts`). It keeps no history and has no PostgreSQL database.

## Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| PostgreSQL table, UPDATE per ping | durable, queryable; a high write rate of rows nobody reads twice; vacuum pressure |
| PostgreSQL + PostGIS history | route replay, disputes, analytics; much more storage; not needed yet |
| Redis GEO set | radius search for dispatch; needs per-member staleness handling ([case study 20](../case-studies/20-nearest-driver-search.md)) |
| time-series DB | right for history at scale; another system |

## Consequences

**Good**
- O(1) writes and reads.
- **Expiry encodes freshness:** no key means "location unknown", not "at the last known point".

**Costs**
- **No history:** you can't answer "where was the driver at 14:05?" for a dispute.
- **No spatial query:** dispatch can't ask "who is near?" ([case study 19](../case-studies/19-driver-dispatch.md)).
- Losing Redis loses current positions. That's acceptable, because drivers re-send within seconds.

**Revisit when** dispatch uses location (add a GEO index alongside), or when the business needs trip history (stream pings to a history store).
