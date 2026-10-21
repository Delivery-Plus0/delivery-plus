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
By default, browser requests are allowed from localhost ports 8081-8085 and
their `127.0.0.1` equivalents (Expo web dev servers, plus the E2E web builds of
the customer app on 8083, the driver app on 8084 and the restaurant app on 8085). Set `CORS_ORIGINS` to a comma-separated list to
override those origins. Allowed request headers include `Content-Type`,
`Authorization`, `X-Correlation-Id`, and `Idempotency-Key`; order and payment
checkout clients use the idempotency header for retry-safe creation.

When `NODE_ENV=production`, `CORS_ORIGINS` is required: the gateway fails to
start rather than silently allowing only the localhost defaults if it is
unset or empty after trimming.

## Client IP and rate limits
Every proxied request carries `x-delivery-plus-client-ip`, the client's address as the gateway saw it. The gateway removes any copy the client sent and sets it again (#203). The services' `RateLimitGuard` counts anonymous callers by it, so `/auth/login`, `/auth/register` and the email resend limits apply per client, not to everyone at once.

Where that address comes from depends on `TRUSTED_PROXY_HOPS` (#251):
- **`0` (default):** clients connect to the gateway directly. The socket address counts, and a client's own `X-Forwarded-For` is ignored.
- **`N`:** `N` reverse proxies in front of the gateway append the address they saw to `X-Forwarded-For`, for example `1` behind one load balancer. The gateway takes the address `N` hops from the right, which the client can't forge: anything it puts in front of the proxies' entries is ignored.

Set it to the exact number of proxies. Too low, and every client shares the balancer's address and limit. Too high, and a client can pick its own address. Any value other than a whole number from 0 to 5 stops the gateway at startup.

## Dependencies
- Depends on all application services for proxying and Compose dependency checks.
- Does not own a database.

## Events published/consumed
- None directly published or consumed in this service.

## Required env vars
- `PORT` (default: `3000`)
- `CORS_ORIGINS` (required in production; see above)
- `TRUSTED_PROXY_HOPS` (default: `0`; see "Client IP and rate limits")
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

`GET /health` and `GET /health/live` return `{ "status": "ok" }` and back the Compose healthcheck on port `3000`. They are liveness checks only: they do not verify that downstream services are reachable.

## Runtime requirement

The proxy uses `http-proxy-middleware` 4.x, which is ESM-only and requires Node `^22.15.0`; the gateway runs on Node 22. Its Jest spec stubs the module with `jest.mock`, because Jest's CommonJS runtime cannot load ESM-only packages and the spec only tests pure helpers.

## Notes
The gateway is intentionally thin; business logic stays in the downstream services. It does not enforce all authorization itself; downstream services validate JWTs and roles. See the root [README](../../README.md) and the service docs index in [../services.md](../services.md).
