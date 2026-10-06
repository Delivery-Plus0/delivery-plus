# ADR 0008 — Payment State Ownership

**Status:** Accepted (reconstructed from commit `e0c7d30` and the payment side-effect work) · [ADRs](README.md) · Books: [25](../25-payment-systems.md), [08](../08-idempotency-and-distributed-operations.md) · Case study: [01](../case-studies/01-failed-payment-race.md)

## Context

- A payment's outcome changes two things:
  - the payment (`payment_service`);
  - the order's status (`order_service`).
- Both a synchronous HTTP call and a Kafka event carry the outcome. Earlier, both paths wrote the order blindly, which produced duplicate confirmations and 500s on declines.

## Decision

1. **payment-service owns payment state.**
   - Transitions are compare-and-set: `transition(id, from, to)`.
   - Payment creation is idempotent per key (partial unique index).
   - Side effects owed for a status (publish the event, sync the order) are tracked by markers (`publishedEventStatus`, `orderSyncedStatus`) and re-run until done, under a lease.
2. **order-service owns order state.**
   - It accepts the payment outcome from either path, with **compare-and-set** writes.
   - Same-status updates are no-ops, and stale events are skipped.
3. **A declined payment ends the order in `FAILED`** (not `CANCELLED`), so both paths agree.
4. **Refunds are ADMIN-only** until a customer refund policy exists.

## Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| order-service owns everything (payment as a sub-state of order) | one writer; mixes money and order logic; payment retries tied to the order service |
| events only (no HTTP sync) | one path; the client waits for consumer lag to see "confirmed" |
| HTTP only (no event) | immediate; notification-service and others lose the signal unless called directly |
| distributed transaction (2PC) | atomic; not supported by Kafka + HTTP + two Postgres DBs in this stack; heavy |

## Consequences

**Good**
- Each service is the single writer of its own state.
- Two delivery paths are safe because writes are conditional and repeatable.

**Costs and known gaps**
- The lease has **no owner token** ([#19](https://github.com/Delivery-Plus0/delivery-plus/issues/19)), so an expired holder can still finish.
- There is **no outbox**: an event can be lost after the commit ([ADR 0010](0010-transactional-outbox.md)).
- Payment is **simulated** (`Math.random() < PAYMENT_SUCCESS_RATE`). A real provider adds webhooks, provider idempotency keys and reconciliation ([Book 25](../25-payment-systems.md)).

**Revisit when** a real payment provider is integrated (webhooks become a third path to the same state), or when refunds open to customers.
