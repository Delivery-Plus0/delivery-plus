# ADR 0010 — Transactional Outbox

**Status: Proposed** (tracked in [#98](https://github.com/Yousefa7medmaher/delivery-plus/issues/98); **not implemented**) · [ADRs](README.md) · Books: [08](../08-idempotency-and-distributed-operations.md), [27](../27-advanced-data-patterns.md) · Case study: [13](../case-studies/13-transactional-outbox.md) · Lab: [DS-11](../labs/distributed-systems-labs.md#ds-11-outbox-simulation)

## Context

- Services commit to PostgreSQL and **then** publish to Kafka.
- A crash or a Kafka outage between the two loses the event while the state change persists.
- Deterministic event IDs and idempotent consumers make *re-publishing* safe, but nothing re-publishes.

## Decision (proposed)

1. **Outbox table.** Each publishing service (order-service and delivery-service first) gets an `outbox` table in its own database:
   - `id` (the event ID), `topic`, `key`, `payload` (jsonb), `headers`, `created_at`, `published_at`.
2. **One transaction.** The business write and the outbox insert happen in the **same transaction**. Request handlers no longer call the producer directly.
3. **A relay in each service** polls unpublished rows with `FOR UPDATE SKIP LOCKED`, in `created_at` order, produces them with the existing producer (key = `orderId`), then marks them published.
4. **Cleanup.** Published rows are deleted after a retention period.
5. **Rollout.**
   - Behind a flag: write the outbox *and* publish directly, letting consumer idempotency absorb the duplicates.
   - Switch to relay-only.
   - Remove the direct publishes.

## Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| keep publish-after-commit + retries | simple; still loses events on crash |
| CDC (Debezium on the WAL) | no polling, low latency; runs Kafka Connect + Debezium |
| event sourcing | events are the source of truth; a rewrite of every service |
| publish-before-commit | consumers may see events for rolled-back changes |

## Consequences

**Good**
- An event is published **if and only if** the state change committed (at least once).

**Costs**
- One table and one relay loop per service.
- Relay lag becomes a metric to monitor.
- Ordering guarantees depend on relay concurrency.
- Migrations add a table with jsonb payloads that must keep old versions readable.

**Open questions**
- Polling interval versus latency.
- One relay per service, or a shared library worker?
- How are HTTP side effects (cart clear, order sync) made reliable? The outbox covers events only.

**Decision owner:** the team, when #98 is scheduled.
