# Cart Service

## Purpose
Manages the current user cart in Redis, including item quantity changes and computed totals.

## Main REST endpoints
From `services/cart-service/src/controllers/cart.controller.ts`:

- `GET /cart` – get the current user cart with total price
- `POST /cart/items` – add an item to the cart
- `PATCH /cart/items/:menuItemId` – update item quantity (0 removes it)
- `DELETE /cart/items/:menuItemId` – remove an item
- `DELETE /cart` – clear the entire cart
- `POST /cart/validate` – re-check the cart against the menu before checkout (#42); order-service calls it when an order is placed

## Checkout re-validation (#42)

- **Quantity cap:** at most `MAX_CART_ITEM_QUANTITY` (20) of one item. Adding past it is a 400; the DTOs reject larger quantities.
- **`POST /cart/validate`** re-reads every item from menu-service:
  - **Unchanged:** the cart is returned, and order-service prices the order from its items (price × quantity, in piasters), never from a client total.
  - **Changed:** the cart is brought up to date, then the answer is `409 CartChanged` with `details.changes`:
    - a different price → `PRICE_CHANGED` (`previousPrice`, `currentPrice`), and the cart now holds the current price;
    - sold out → `UNAVAILABLE`; archived, deleted or moved to another restaurant → `REMOVED`; both are taken out of the cart;
    - an old line over the cap → `QUANTITY_LIMITED`, lowered to 20.
  - A renamed item is refreshed quietly: what the customer pays doesn't change.
  - A menu-service outage is an error, never a "removed" item.
- **Why refuse instead of charging the new price:** the customer always pays the total they were shown. After a 409 the app re-reads the cart and quote, and the customer places the order again.

## Dependencies
- Uses Redis via `CartRepository`
- Calls `menu-service` to validate item existence and price/availability via `src/common/menu-service.client.ts`
- Is a dependency of `order-service` when creating an order from the cart

## Events published/consumed
- No Kafka event producer/consumer is implemented in this service.

## Required env vars
From `services/cart-service/src/config/app-config.ts`:

- `REDIS_URL`
- `JWT_SECRET`
- `MENU_SERVICE_URL` (default: `http://localhost:3004`)
- `CART_TTL_SECONDS` (default: `86400`)
- `PORT` (default: `3005`)
- `NODE_ENV` (default: `development`)

## Notes
The cart is intentionally lightweight and backed by Redis, which keeps the read/write operations fast and decoupled from the relational stores.
