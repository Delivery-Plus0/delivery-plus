# API Gateway

## Role of the gateway

The API gateway is the publicly reachable entry point for the platform. It accepts client traffic, routes requests to downstream services, and centralizes the routing and cross-cutting concerns that should not be duplicated across every service.

The main implementation entry point is:

- [services/api-gateway/src/main.ts](../services/api-gateway/src/main.ts)

## Routing model

The gateway uses HTTP proxy middleware to forward path prefixes to service-specific internal URLs.

The main route groups are:

- `/api/auth`
- `/api/users`
- `/api/restaurants`
- `/api/menus`
- `/api/cart`
- `/api/orders`
- `/api/payments`
- `/api/deliveries`
- `/api/drivers`
- `/api/tracking`
- `/api/notifications`

These route mappings are intentionally coarse and align with the underlying service boundaries.

## Gateway responsibilities

### 1. External access boundary

All client-facing requests enter through the gateway. That keeps the internal service network private and keeps downstream services easier to evolve.

### 2. Service discovery via environment configuration

The gateway is configured with upstream URLs such as:

- `AUTH_SERVICE_URL`
- `USER_SERVICE_URL`
- `RESTAURANT_SERVICE_URL`
- `MENU_SERVICE_URL`
- `CART_SERVICE_URL`
- `ORDER_SERVICE_URL`
- `PAYMENT_SERVICE_URL`
- `DELIVERY_SERVICE_URL`
- `DRIVER_SERVICE_URL`
- `TRACKING_SERVICE_URL`
- `NOTIFICATION_SERVICE_URL`

Those values are set in [docker-compose.yml](../docker-compose.yml) and enable the gateway to forward traffic to the correct service by path prefix.

### 3. Swagger aggregation

The gateway sets up Swagger endpoints and exposes grouped API documentation, making the platform easier to explore without contacting each service individually. In addition to the live gateway docs, the repository now includes a generated public contract at [docs/openapi/delivery-plus-public.json](../docs/openapi/delivery-plus-public.json) that represents the public Gateway API surface for Apidog import and API automation.

The public contract intentionally excludes internal-only routes and keeps the public path model aligned with the Gateway prefixes:

- `/api/auth`
- `/api/users`
- `/api/restaurants`
- `/api/menus`
- `/api/cart`
- `/api/orders`
- `/api/payments`
- `/api/deliveries`
- `/api/drivers`
- `/api/tracking`
- `/api/notifications`

The Menu service remains a special case because its controllers are mounted at the root and therefore must be exposed under `/api/menus` at the gateway boundary without breaking the service’s own root-level internal paths.

## Health and readiness

The gateway currently has no controller or `/health` route. Compose nevertheless probes `http://localhost:3000/health`, so the gateway healthcheck is a known mismatch and should not be documented as a working readiness signal. The downstream domain services expose the health routes used by their Compose checks.

This is documented in:

- [docker-compose.yml](../docker-compose.yml)

## Security and auth flow

The gateway acts as the boundary where client requests are routed, but the actual auth enforcement is still service-level. The platform uses a shared auth pattern with JWTs and role-based checks. In practice:

- client authenticates through the auth service
- token is passed on subsequent requests
- downstream services validate those tokens and roles as needed

The gateway should not be treated as the only enforcement layer; actual permission logic still happens in application services. Internal service authentication is defined by and implemented according to [ADR 001](../docs/adr/001-internal-service-authentication.md). The gateway explicitly returns `404` for `/api/users/internal/*`, so the internal profile-creation route is not publicly proxied.

## Browser CORS

The gateway's default browser origins are localhost ports 8081-8083 and their
127.0.0.1 equivalents. `CORS_ORIGINS` can replace that list. Allowed request
headers include `Authorization`, `X-Correlation-Id`, and `Idempotency-Key`;
the latter is required for browser checkout requests that use retry-safe order
and payment creation.

## Current architecture assumptions

The gateway is not a full API management layer. It is a thin reverse-proxy and documentation front door, which fits this repository’s microservice style.

The system design implicitly assumes:

- clients rely on the gateway for entry
- service-to-service calls remain internal and HTTP-based where needed
- async coordination is handled with Kafka rather than direct synchronous orchestrations

## Source of truth

- Gateway implementation: [services/api-gateway/src/main.ts](../services/api-gateway/src/main.ts)
- Compose environment wiring: [docker-compose.yml](../docker-compose.yml)
- Shared topic definitions: [shared/src/events/topics.ts](../shared/src/events/topics.ts)
- Service docs index: [docs/services.md](../docs/services.md)
