# Service Map

This file is the high-level dependency map. For deeper service-by-service detail, use the docs in [../docs/services.md](../docs/services.md) and the pages under [../docs/services](../docs/services).

| Service | Port | Depends on | Depended on by | Owns / persists | Publishes | Consumes |
| --- | ---: | --- | --- | --- | --- | --- |
| api-gateway | 3000 | all app services | clients | none | none | none |
| auth-service | 3001 | PostgreSQL, Redis (rate limits), user-service | gateway | credentials + auth state (verification, lockout) | none | none |
| user-service | 3002 | PostgreSQL, Redis (internal-auth nonces), S3, order-service | gateway, auth-service | user profiles + avatar URLs | none | none |
| restaurant-service | 3003 | PostgreSQL, Redis (cache), S3 | gateway, menu-service, order-service | restaurants + cover/logo URLs | none | none |
| menu-service | 3004 | PostgreSQL, Redis (cache), S3, restaurant-service | gateway, cart-service | menu items and categories + item image URLs | none | none |
| cart-service | 3005 | Redis, menu-service | gateway, order-service | user cart state | none | none |
| order-service | 3006 | PostgreSQL, Redis (rate limits), cart-service, restaurant-service, Kafka | gateway, payment-service, delivery-service, user-service | orders | order.events | payment.events, delivery.events |
| payment-service | 3007 | PostgreSQL, order-service, Kafka | gateway | payment records | payment.events | none |
| delivery-service | 3008 | PostgreSQL, Redis (Kafka idempotency), order-service, driver-service, restaurant-service, Kafka | gateway | delivery records | delivery.events (one per lifecycle transition) | order.ready_for_pickup (auto-dispatch) |
| driver-service | 3009 | PostgreSQL | delivery-service, tracking-service | drivers (availability: compare-and-set; drivers only go online/offline, delivery-service claims and releases) | none | none |
| tracking-service | 3010 | Redis, delivery-service, driver-service | gateway | last-known locations | none | none |
| notification-service | 3011 | PostgreSQL, Kafka | gateway | notification records | none | order.events, payment.events, delivery.events |

## Port and route conventions

- Gateway: `3000`
- Service ports follow the default mapping in `docker-compose.yml`
- Service-specific routes are defined in each controller, normally under the route prefix of the service, e.g. `/orders`, `/deliveries`, `/drivers`, `/tracking`

## Cross-service relationships

- `auth-service` creates the user profile via `user-service` using an HMAC-signed internal request with a one-time nonce
- `user-service`, `restaurant-service`, and `menu-service` issue presigned upload policies and verify uploaded images through the shared `S3StorageService`
- `menu-service` verifies ownership with `restaurant-service`
- `cart-service` validates menu items from `menu-service`
- `order-service` orchestrates state changes using cart and restaurant checks
- `payment-service` updates order status based on payment outcome
- `delivery-service` dispatches automatically on `order.ready_for_pickup` (create + assign; deliveries waiting for a driver are retried every `AUTO_DISPATCH_SWEEP_MS`), assigns drivers (claim AVAILABLE → BUSY, moving to the next driver if a concurrent assignment wins), updates order status and publishes `delivery.events`
- `tracking-service` enriches delivery progress using delivery and driver service data
- `notification-service` listens for asynchronous events, but payment and delivery handlers currently contain no-op behavior pending the required lookup/contract work

## Notes

This document is intentionally map-like and not a full deep dive; the details live in the service docs and the event design file.
