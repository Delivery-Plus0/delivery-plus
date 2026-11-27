# Restaurant availability (#286)

The rule for who can order when, as decided by the project owner (November 2026). The backend applies it; the apps only display what the backend returns.

## Statuses

| Status | Set by | Customers can order |
| --- | --- | --- |
| `OPEN` | Owner | Yes |
| `BUSY` | Owner, when the kitchen is overloaded | **No**: "busy right now, try again in a few minutes" |
| `CLOSED` | Owner | No: "closed right now" |
| `SUSPENDED` | Platform staff (`ops.act`) | No, and customers don't see it at all (#215) |

## Rules

- Only an `OPEN` restaurant takes **new** orders. Checkout answers `409 RestaurantBusy` for `BUSY` and `409 RestaurantClosed` for `CLOSED` or `SUSPENDED`; no order or payment is created.
- Customers can still open the restaurant and its menu while it is `OPEN`, `BUSY` or `CLOSED`; the app shows the status and blocks checkout.
- A `SUSPENDED` restaurant disappears from customers at once: it isn't in the list, and opening it by id answers 404 (owner decision, 27 November 2026, #215). Its orders already placed are not affected. Lifting the suspension brings it back `CLOSED`, and the owner opens it.
- `BUSY` is temporary. Customers keep their cart and can place the order once the owner switches back to `OPEN`. The app says so instead of promising a time: the backend has no busy-until time.
- Orders already placed are not affected: the kitchen keeps preparing them whatever the status.
- Owners switch between `OPEN`, `BUSY` and `CLOSED` themselves; only staff can suspend a restaurant or lift a suspension (`POST /api/admin/restaurants/:id/suspend` and `/reactivate`, audited, the owner is told).
