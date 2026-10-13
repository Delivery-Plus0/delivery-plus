# Cancellations, refunds and compensation (#53, #56)

These are the project owner's rules, decided on 2026-10-13. The backend enforces them; the apps only show what the backend returns. The delivery fee and the driver's normal earnings are in [delivery-fee-and-earnings.md](delivery-fee-and-earnings.md).

## The rules

1. **A customer may cancel only before the restaurant starts preparing.** That means while the order is `CREATED`, `PAYMENT_PENDING` or `CONFIRMED`. order-service enforces this for every caller, not just the customer app. Later, the API answers `409`.
2. **A restaurant may reject only a `CONFIRMED` order**, with a reason (#154).
3. **The platform (an admin, or a service acting for it) may cancel any order that isn't finished.**
   - Once a driver is on the order (`DRIVER_ASSIGNED` or `PICKED_UP`), the cancellation goes through the delivery: `POST /deliveries/:id/cancel`, ADMIN only. That way delivery-service decides it against the driver's own actions; see [Concurrency](#concurrency).
   - order-service refuses a human admin's direct order cancellation from those states with `409`.
4. **Full refund when money was collected.** When an order ends `CANCELLED` and its payment was `COMPLETED`, the whole payment is refunded:
   - the items and the EGP 25 delivery fee;
   - whoever cancelled: the customer, the restaurant (rejection) or the platform.

   No payment collected (none, still pending, or declined) means no refund.
5. **A payment that completes after its order was cancelled** is refunded immediately. The money is never kept for an order that won't be delivered.
6. **Post-pickup compensation.**
   - When the platform cancels a delivery after pickup (`PICKED_UP` or `IN_TRANSIT`), the driver gets **25 % of the delivery fee** (EGP 6.25 with the EGP 25 fee) as a separate `CANCELLATION_COMPENSATION` ledger entry.
   - The platform funds it; the customer is still refunded in full.
7. **Nothing is reversed that was never paid.** A cancelled delivery never recorded a `DELIVERY_EARNING`, so there is nothing to reverse.
   - A delivered order can't be cancelled.
   - A support refund after delivery leaves the driver's earning as it is.
8. **Refunds are simulated** (`provider = SIMULATED`), like payments, until a real payment gateway is integrated.

## State transitions

### Order (order-service)

```text
CREATED ──► PAYMENT_PENDING ──► CONFIRMED ──► PREPARING ──► READY_FOR_PICKUP ──► DRIVER_ASSIGNED ──► PICKED_UP ──► DELIVERED
   │              │   │             │              │                │                    │               │
   │              │   └─► FAILED    │              │                │                    │               │
   └──────────────┴─────────────────┴──────────────┴────────────────┴────────────────────┴───────────────┴──► CANCELLED
```

Who may move an order to `CANCELLED`, by its current status:

| From | Customer | Restaurant owner | Admin (direct) | Platform service / delivery cancel |
| --- | --- | --- | --- | --- |
| `CREATED`, `PAYMENT_PENDING` | ✅ | — | ✅ | ✅ |
| `CONFIRMED` | ✅ | ✅ reject with reason | ✅ | ✅ |
| `PREPARING`, `READY_FOR_PICKUP` | ❌ 409 | ❌ 409 | ✅ | ✅ |
| `DRIVER_ASSIGNED`, `PICKED_UP` | ❌ 409 | ❌ 409 | ❌ 409: cancel the delivery | ✅ |
| `DELIVERED`, `CANCELLED`, `FAILED` | final | final | final | final |

Repeating a cancellation of a `CANCELLED` order returns the order unchanged, so it is safe to retry.

### Payment (payment-service)

```text
PENDING ──► PROCESSING ──► COMPLETED ──► REFUNDED
   │             │
   └─────────────┴──► FAILED
```

- **`REFUNDED` is reached only from `COMPLETED`**, and only by the refund flow below. It is final.
- **The refund record.** Each refund writes one row in `refunds`:
  - payment, order, customer, amount, `EGP`;
  - who ended the order (`CUSTOMER`, `RESTAURANT`, `SYSTEM`) or `SUPPORT` for a support refund, plus the support user's id;
  - the reason;
  - the source (the `order.cancelled` eventId, or the support request);
  - the provider (`SIMULATED`).

  A unique index on `paymentId` allows one refund per payment.

### Delivery and driver ledger (delivery-service)

| Delivery cancelled from | Driver ledger entry | Driver |
| --- | --- | --- |
| `CREATED` (no driver yet) | none | — |
| `DRIVER_ASSIGNED` | none | released |
| `PICKED_UP`, `IN_TRANSIT` | `CANCELLATION_COMPENSATION`, 25 % of the fee | released |
| `DELIVERED` | can't be cancelled; the `DELIVERY_EARNING` (50 %) stays | — |

The ledger entry is written in the same transaction as the move to `CANCELLED`. The unique index on `(deliveryId, type)` makes it one entry per delivery.

## How a cancellation flows

1. The order moves to `CANCELLED`. The change and its `order.cancelled` event are written in one transaction (outbox), with `cancelledBy` and the reason.
2. **payment-service** consumes `order.cancelled`:
   - **Payment `COMPLETED`:** refund it. Lock the payment row, write the refund and move the payment to `REFUNDED`, all in one transaction. Then publish `payment.refunded`.
   - **Payment `PENDING` or `PROCESSING`:** nothing yet. When it completes, completion sees the cancelled order and refunds it (rule 5).
   - **No payment, or `FAILED`:** nothing to refund.
3. **delivery-service** consumes `order.cancelled`. If the order has an active delivery, it cancels it:
   - releases the driver;
   - writes the compensation if the delivery was past pickup.
4. **order-service** consumes `payment.refunded` and records `paymentStatus = REFUNDED` on the order. The customer's order screen and history show it.
5. **notification-service** tells the customer:
   - that the order was cancelled, when the restaurant or the platform cancelled it;
   - that the refund was issued, with the amount (`payment.refunded`);
   - **also new:** a declined payment (`payment.failed`).

A platform cancellation through the delivery runs the same steps:
1. delivery-service cancels the delivery, with any compensation and the platform's reason (`deliveries.cancellationReason`).
2. It then cancels the order, which publishes `order.cancelled`.
3. order-service also converges the order from `delivery.cancelled`, which carries the same reason. Whichever arrives first records it, so the customer sees the platform's words either way.

## Idempotency and audit

| Effect | Guarantee |
| --- | --- |
| Order cancellation | Compare-and-set on the status. Only the winner stages `order.cancelled`. Its eventId is deterministic per order. |
| Refund | Row lock on the payment, a unique `refunds.paymentId`, and `COMPLETED → REFUNDED` in the same transaction. A second attempt finds `REFUNDED` and does nothing. |
| `payment.refunded` event | Deterministic eventId per payment. Publication is tracked on the payment (`publishedEventStatus`); a sweep finishes any event still owed. |
| Compensation | Written with the delivery's move to `CANCELLED`; unique per `(deliveryId, type)`. |
| Delivery cancellation from the event | Compare-and-set; a delivery already `CANCELLED` is a no-op. |
| Redelivered events | Each consumer group skips events it already handled. Every handler above is also idempotent on its own, so a replay from a dead-letter topic is safe. |

**Audit trail:**
- **Order:** `cancelledBy`, `cancellationReason` and `paymentStatus`.
- **Payment and refund:** the payment's status and the `refunds` row.
- **Driver:** the ledger entry.

Nothing is edited after the fact; a correction would be a new entry.

## Concurrency

| Race | Outcome |
| --- | --- |
| Customer cancels while the payment is processing | The cancel wins on the order. The payment completes, sees `CANCELLED`, and refunds itself. |
| Cancellation and payment completion both try to refund | The payment row lock serializes them: one refunds, the other finds `REFUNDED`. |
| Two cancel requests | The compare-and-set lets one write; the other returns the cancelled order. |
| Platform cancel vs. the driver completing | Both go through delivery-service's compare-and-set on the delivery. If delivery wins, the delivery and order stay delivered, the driver gets the normal earning, and the cancel gets `409`. If cancel wins, the completion gets `409`, the driver gets the compensation, and the customer is refunded. |
| Order cancelled while auto-dispatch creates its delivery | Before assigning a driver, delivery-service checks the order. A delivery for a cancelled order is cancelled instead of assigned. |

## Not covered yet

- **A real payment gateway**, so real refunds, partial refunds and refund failures.
- **Refunds of a refund, and chargebacks.**
- **Support-initiated partial refunds.** `POST /payments/:id/refund` is a full refund, ADMIN only.
