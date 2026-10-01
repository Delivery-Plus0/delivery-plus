# ADR 0002 — Redis for Carts

**Status:** Accepted (reconstructed teaching ADR) · [ADRs](README.md) · Books: [06](../06-redis.md), [04](../04-database-fundamentals.md) · Lab: [RD-02](../labs/redis-labs.md#rd-02-lost-update-in-the-cart)

## Context

- A cart is short-lived, per customer, read and written often, and worthless once it becomes an order or is abandoned.
- It holds items from **one** restaurant.

## Decision

cart-service stores each cart as one JSON value at `cart:{userId}` in Redis, with a TTL of `CART_TTL_SECONDS` (default 86,400 s = 24 h), refreshed on save (`services/cart-service/src/repositories/cart.repository.ts`). cart-service has no PostgreSQL database.

## Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| PostgreSQL `carts` + `cart_items` | durable, transactional, queryable (abandoned-cart analytics); more writes on a hot path, plus cleanup jobs |
| client-only cart (app storage) | zero server load; prices can't be trusted and the cart can't move across devices |
| Redis hash per cart (`HINCRBY` per item) | atomic per-item updates; harder to keep `restaurantId` consistent |

## Consequences

**Good**
- Fast.
- Expiry is free.
- No migrations.

**Costs**
- **Lost updates.** The repository reads JSON, modifies it in Node, then writes it back. Two concurrent adds can lose one ([RD-02](../labs/redis-labs.md#rd-02-lost-update-in-the-cart)). Fixes: `WATCH`/`MULTI`, a Lua script, or a hash per cart.
- **Durability depends on Redis persistence** (AOF is on since `0962284`). Losing Redis loses carts, which is acceptable as an annoyance rather than lost money.
- **Prices are copied into the cart** when items are added. Checkout uses the cart's prices, so stale prices are possible (`issues/031-cart-stale-price-and-restaurant-boundary.md`).
- No analytics on abandoned carts without extra work.

**Revisit when** carts need to survive for weeks, be shared, or be analysed, or when lost updates show up in support tickets.
