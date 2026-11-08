# Restaurant availability (#286)

The rule for who can order when, as decided by the project owner (November 2026). The backend applies it; the apps only display what the backend returns.

## Statuses

| Status | Set by | Customers can order |
| --- | --- | --- |
| `OPEN` | Owner | Yes |
| `BUSY` | Owner, when the kitchen is overloaded | **No**: "busy right now, try again in a few minutes" |
| `CLOSED` | Owner | No: "closed right now" |
| `SUSPENDED` | Platform admin | No |

## Rules

- Only an `OPEN` restaurant takes **new** orders. Checkout answers `409 RestaurantBusy` for `BUSY` and `409 RestaurantClosed` for `CLOSED` or `SUSPENDED`; no order or payment is created.
- Customers can still open the restaurant and its menu in every status; the app shows the status and blocks checkout.
- `BUSY` is temporary. Customers keep their cart and can place the order once the owner switches back to `OPEN`. The app says so instead of promising a time: the backend has no busy-until time.
- Orders already placed are not affected: the kitchen keeps preparing them whatever the status.
- Owners switch between `OPEN`, `BUSY` and `CLOSED` themselves; only an admin can suspend a restaurant or lift a suspension.
