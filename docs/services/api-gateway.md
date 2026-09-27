# API Gateway

## Purpose
The API Gateway is the single public entry point for the platform. It proxies traffic to the downstream microservices and exposes the combined Swagger UI at `/docs`.

## Main routes
The gateway routes are defined in `services/api-gateway/src/main.ts`:

- `/api/auth` -> `auth-service` (`/auth`)
- `/api/users` -> `user-service` (`/users`)
- `/api/restaurants` -> `restaurant-service` (`/restaurants`)
- `/api/menus` -> `menu-service` root routes (`/categories`, `/restaurants/:restaurantId/menu`, and `/menu-items`)
- `/api/cart` -> `cart-service` (`/cart`)
- `/api/orders` -> `order-service` (`/orders`)
- `/api/payments` -> `payment-service` (`/payments`)
- `/api/deliveries` -> `delivery-service` (`/deliveries`)
- `/api/drivers` -> `driver-service` (`/drivers`)
- `/api/tracking` -> `tracking-service` (`/tracking`)
- `/api/notifications` -> `notification-service` (`/notifications`)

The service listens on port `3000` by default and is configured via environment variables such as `AUTH_SERVICE_URL`, `USER_SERVICE_URL`, `ORDER_SERVICE_URL`, etc.

The gateway restores the downstream service prefix for services whose controllers retain one. The menu controller is registered at the downstream root, so the gateway deliberately strips `/api/menus` completely. For example, `POST /api/auth/register` becomes `POST /auth/register`, while `GET /api/menus/restaurants/:id/menu` becomes `GET /restaurants/:id/menu`.

## Browser CORS
By default, browser requests are allowed from localhost ports 8081-8083 and
their `127.0.0.1` equivalents. Set `CORS_ORIGINS` to a comma-separated list to
override those origins. Allowed request headers include `Content-Type`,
`Authorization`, `X-Correlation-Id`, and `Idempotency-Key`; order and payment
checkout clients use the idempotency header for retry-safe creation.

## Dependencies
- Depends on all application services for proxying and Compose dependency checks.
- Does not own a database.

## Events published/consumed
- None directly published or consumed in this service.

## Required env vars
- `PORT` (default: `3000`)
- `AUTH_SERVICE_URL` (default: `http://localhost:3001`)
- `USER_SERVICE_URL` (default: `http://localhost:3002`)
- `RESTAURANT_SERVICE_URL` (default: `http://localhost:3003`)
- `MENU_SERVICE_URL` (default: `http://localhost:3004`)
- `CART_SERVICE_URL` (default: `http://localhost:3005`)
- `ORDER_SERVICE_URL` (default: `http://localhost:3006`)
- `PAYMENT_SERVICE_URL` (default: `http://localhost:3007`)
- `DELIVERY_SERVICE_URL` (default: `http://localhost:3008`)
- `DRIVER_SERVICE_URL` (default: `http://localhost:3009`)
- `TRACKING_SERVICE_URL` (default: `http://localhost:3010`)
- `NOTIFICATION_SERVICE_URL` (default: `http://localhost:3011`)

## Health and readiness

The gateway currently has no controller or `/health` route. Compose still probes `http://localhost:3000/health`, so the gateway healthcheck is a known mismatch rather than a working readiness endpoint.

## Notes
The gateway is intentionally thin; business logic stays in the downstream services. It does not enforce all authorization itself; downstream services validate JWTs and roles. See the root [README](../../README.md) and the service docs index in [../services.md](../services.md).
