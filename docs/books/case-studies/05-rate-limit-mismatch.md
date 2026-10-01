# Case Study 05 — Rate-Limit Mismatch

**Status: CURRENT (fixed in commit `8f0ecc0`)** · [Case studies](README.md) · Books: [06](../06-redis.md), [11](../11-nestjs-typescript-backend.md), [17](../17-security-engineering.md) · Lab: [RD-04](../labs/redis-labs.md#rd-04-fixed-window-rate-limiter)

## Symptom

The cart controller declared a rate limit (30 requests per 60 s), but no cart request was ever rejected with 429.

## Root cause

- cart-service put `@RateLimit(...)` on the **controller class**.
- `RateLimitGuard` (`shared/src/redis/rate-limit.guard.ts`) only read metadata from the **handler**:
  ```ts
  const options = this.reflector.get<RateLimitOptions>(RATE_LIMIT_KEY, context.getHandler());
  ```
- No options were found, so the guard allowed the request.

The decorator compiled, looked right, and did nothing.

## Why the naive version looked reasonable

- Every other service put `@RateLimit` on handlers, so the guard was written for that case.
- NestJS decorators such as `@UseGuards` work on both classes and methods, so a developer reasonably expected `@RateLimit` to as well.
- Nothing failed. A missing limit is invisible until someone abuses it.

## Impact

The cart endpoints were unlimited. A client bug or a script could hammer cart-service and the menu-service lookups behind it.

## Fix

```ts
const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
  context.getHandler(),
  context.getClass(),
]);
```
A handler-level limit wins; otherwise the class-level one applies.

## Tests

- `shared/src/redis/rate-limit.guard.spec.ts` covers handler-level, class-level, override, and no metadata.
- Live: [SEC-01](../labs/security-labs.md#sec-01-status-code-tour) expects a 429 on the 31st cart request; [RD-04](../labs/redis-labs.md#rd-04-fixed-window-rate-limiter) inspects the key `ratelimit:/cart:<customerId>`.

## Trade-offs

The guard is still a **fixed-window** counter:
- `INCR` then `EXPIRE` as two separate commands, which is not atomic.
- It allows up to 2× the limit across a window boundary.
- It keys on the route and user (or IP).

That is simple and good enough for abuse protection, but not for fairness or billing.

## What can still go wrong

- If the process dies between `INCR` and `EXPIRE`, a key with no TTL is left behind, and that user stays limited until someone deletes it. A Lua script or `SET … EX NX` + `INCR` fixes it.
- Limits live in Redis. The guard has no `try/catch`, so if Redis is down the error propagates and the request fails: it **fails closed**, with a 5xx rather than a 429. That's right for login, but debatable for browsing the cart.
- Behind a proxy, "IP" may be the proxy's IP unless `trust proxy` is configured.

## What a senior engineer would ask

1. What test would have caught "a decorator that does nothing"? (Answer: a test per decorated controller that asserts a 429, not just a unit test of the guard.)
2. Fail open or fail closed when Redis is down? Different for login and for cart?
3. Fixed window, sliding window or token bucket? Which fits checkout, and why ([Book 06](../06-redis.md))?
