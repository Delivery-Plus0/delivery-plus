# Delivery fee and driver earnings (#145)

The accounting rules, as decided by the project owner. The backend applies them; the apps only display what the backend returns.

## The delivery fee

- The customer pays the **items plus a flat delivery fee** per order. Example: subtotal EGP 200 + fee EGP 25 = **EGP 225**.
- The fee is configuration, not code: `DELIVERY_FEE` on order-service (EGP, default `25.00`).
- At checkout, order-service prices the order and stores a **snapshot** on it: `subtotalAmount`, `deliveryFee`, `totalAmount`, and the internal split below. Changing the configuration never changes an existing order.
- The payment charges the order's `totalAmount`, so the cart quote (`GET /orders/quote`), the order and the payment always show the same fee and total.

## How the fee is split

| Outcome | Driver | Platform |
| --- | --- | --- |
| Delivery completed | **50 %** of the fee (`DELIVERY_FEE_DRIVER_SHARE_PERCENT`) | the rest (50 %) |
| Delivery cancelled **after pickup** (PICKED_UP or IN_TRANSIT) | **25 %** of the fee (`DELIVERY_FEE_DRIVER_CANCEL_AFTER_PICKUP_PERCENT`) | the rest |
| Cancelled before pickup | nothing | — |

With the EGP 25 fee, the driver earns EGP 12.50 for a completed delivery and EGP 6.25 for a cancellation after pickup.

Amounts are computed in whole piasters. The driver's share is rounded down and the platform keeps the remainder, so the two always add up to the fee exactly.

The split is stored on the order at checkout, but it is internal. It is never returned to customers or restaurants; delivery-service reads it through an ADMIN-only route.

## The driver ledger (delivery-service)

- **Append-only.** There is one entry per delivery and type (`DELIVERY_EARNING`, `CANCELLATION_COMPENSATION`), enforced by a unique index.
- **Written with the status change.** The entry is written in the same database transaction as the move to DELIVERED (or to CANCELLED after pickup). A delivery can't finish without its earning, and a retried request or redelivered event can't pay twice.
- **Settlement.** Every entry starts **PENDING** and becomes **AVAILABLE** 12 hours after the delivery finished (`EARNINGS_SETTLEMENT_HOURS`, default 12).
  - The move is automatic and idempotent: a sweep runs every `EARNINGS_SETTLE_SWEEP_MS`, and every earnings read first settles the reader's due entries.
  - AVAILABLE means available in the internal driver wallet. There are **no bank payouts** yet.
- **Balance = the sum of the entries.** Nothing is stored separately that could drift.
- **Corrections are new entries** (`REVERSAL`, negative), never edits. Nothing produces them yet: refunds are #53/#56.
- Orders from before fees existed have a zero fee and produce no entry.

## Read API

`GET /deliveries/me/earnings?page&limit` (DRIVER, own entries only) returns:
- `currency` (always `EGP`);
- `pending`, `available` and `balance`;
- `settlementHours`;
- the newest entries (type, amount, status, `availableAt`).

The wallet screen is #146.
