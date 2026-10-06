# Case Study 01 — Failed-Payment Race

**Status: CURRENT (fixed in commit `e0c7d30`)** · [Case studies](README.md) · Books: [08](../08-idempotency-and-distributed-operations.md), [09](../09-distributed-systems.md), [25](../25-payment-systems.md) · Labs: [DS-05](../labs/distributed-systems-labs.md#ds-05-concurrent-order-confirmation), [DS-08](../labs/distributed-systems-labs.md#ds-08-declined-payment-end-to-end)

## Symptom

- A declined payment sometimes made `POST /api/payments/:id/process` return **500**. The order stayed in `PAYMENT_PENDING` and was never marked failed.
- On successful payments, customers sometimes got **two** "Order Confirmed" notifications.

## Root cause

Two writers changed the same order status:

1. **The synchronous path.** `payment-service` calls order-service over HTTP (`updateOrderStatus`) right after processing the payment.
2. **The asynchronous path.** order-service consumes `payment.events` and applies the same status from the event.

`OrdersRepository.updateStatus(id, status)` was a blind write: `UPDATE orders SET status = $2 WHERE id = $1`.

- **Confirmation:** both writers read the order as `PAYMENT_PENDING`, both passed the transition check, and both wrote `CONFIRMED`. Each one published `order.confirmed`, so the customer got two notifications.
- **Decline:** whichever writer came second saw a status it did not expect. It hit an invalid transition and surfaced a `ConflictError`, which reached the client as 500.

## Why the naive version looked reasonable

- Each path was correct on its own. The HTTP sync gives the client an immediate answer.
- The consumer is the "eventually consistent" safety net in case the HTTP call failed.
- Unit tests exercised each path in isolation, and no single test had two writers.

## Impact

- Duplicate customer notifications.
- Failed checkouts reported as server errors, with the order stuck in `PAYMENT_PENDING`.
- In the same commit: customers could refund their own `COMPLETED` payment at any time, even after delivery.

## Fix

- **Compare-and-set status writes** (`services/order-service/src/repositories/orders.repository.ts`):
  ```ts
  async updateStatus(id: string, from: OrderStatus, to: OrderStatus): Promise<Order | null> {
    const result = await this.repo.update({ id, status: from }, { status: to });
    return result.affected ? this.findById(id) : null;
  }
  ```
  Only one writer can move `PAYMENT_PENDING → CONFIRMED`. The loser gets `null`, finds the order already in the target status, and treats it as a no-op (no second event).
- **Declines end in `FAILED`.** New `order.payment_pending` and `order.failed` events (`shared/src/events/order-events.ts`).
- **Late or stale events are tolerated.** order-service's `syncStatusFromEvent` skips same-status and stale events instead of failing.
- **`syncOrder` in payment-service** (`services/payment-service/src/services/payments.service.ts`): a conflict on a FAILED payment is accepted only if the order is already terminal (the customer cancelled first). A COMPLETED payment on a closed order still errors, because that money needs a refund.
- **Refunds are ADMIN-only.**

## Tests

- `services/order-service/src/services/orders.service.spec.ts` covers:
  - the CAS loser doesn't publish;
  - same-status updates are no-ops;
  - stale events are skipped.
- `services/payment-service/src/services/payments.service.spec.ts` covers:
  - a declined payment on an already-cancelled order;
  - a refund attempted by a non-admin.
- Live: [DS-05](../labs/distributed-systems-labs.md#ds-05-concurrent-order-confirmation) and [DS-08](../labs/distributed-systems-labs.md#ds-08-declined-payment-end-to-end).

## Trade-offs

- **Two writers remain by design.** The HTTP path gives the client a fast, accurate answer, and the consumer converges. CAS makes the pair safe without picking one owner.
- Writes now tell you *whether* they happened, so every caller must handle `null`. That's more code in exchange for correctness.

## What can still go wrong

- The event is published **after** the database write with no outbox. A crash between the two loses the event ([case study 13](13-transactional-outbox.md)).
- Payment side effects use a lease with no owner token ([#19](https://github.com/Delivery-Plus0/delivery-plus/issues/19)). A slow worker whose lease expired can still finish its side effects while a second worker runs them too.
- Payment success is simulated: `Math.random() < PAYMENT_SUCCESS_RATE`. There is no real gateway, webhook or reconciliation ([Book 25](../25-payment-systems.md)).

## What a senior engineer would ask

1. Who *owns* order status: order-service alone, or anyone with a token? (See [ADR 0008](../adrs/0008-payment-state-ownership.md).)
2. Why did no test have two concurrent writers? What would such a test look like at the repository level?
3. If the HTTP sync were removed and only the event path kept, what would the client see, and for how long?
4. How would you detect duplicate confirmations in production *before* customers complain?
