import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimit } from './rate-limit.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimiterService } from './rate-limiter.service';
import { AppError } from '../errors/app-error';

@RateLimit({ limit: 2, windowSeconds: 60 })
class ClassLimitedController {
  addItem() {}

  @RateLimit({ limit: 5, windowSeconds: 10 })
  routeOverride() {}
}

class UnlimitedController {
  open() {}
}

class KeyedController {
  @RateLimit({ limit: 1, windowSeconds: 60, key: (request) => (request.body as { session?: string } | undefined)?.session })
  refresh() {}
}

/** In-memory stand-in for the Redis counter so the limit can be exercised end to end. */
function fakeLimiter() {
  const counts = new Map<string, number>();
  return {
    incrementAndCheck: jest.fn(async (key: string, limit: number) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next <= limit;
    }),
  };
}

function contextFor(controller: new () => object, handler: string, userId = 'user-1'): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    switchToHttp: () => ({ getRequest: () => ({ user: { sub: userId }, route: { path: `/${handler}` } }) }),
  } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  it('enforces a limit declared on the controller class (regression: it used to be ignored)', async () => {
    const limiter = fakeLimiter();
    const guard = new RateLimitGuard(new Reflector(), limiter as unknown as RateLimiterService);
    const ctx = contextFor(ClassLimitedController, 'addItem');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ statusCode: 429 });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(AppError);
    expect(limiter.incrementAndCheck).toHaveBeenCalledWith('ratelimit:/addItem:user-1', 2, 60);
  });

  it('lets a route-level limit override the class-level one', async () => {
    const limiter = fakeLimiter();
    const guard = new RateLimitGuard(new Reflector(), limiter as unknown as RateLimiterService);

    await guard.canActivate(contextFor(ClassLimitedController, 'routeOverride'));

    expect(limiter.incrementAndCheck).toHaveBeenCalledWith('ratelimit:/routeOverride:user-1', 5, 10);
  });

  it('counts each user separately', async () => {
    const limiter = fakeLimiter();
    const guard = new RateLimitGuard(new Reflector(), limiter as unknown as RateLimiterService);

    await guard.canActivate(contextFor(ClassLimitedController, 'addItem', 'a'));
    await guard.canActivate(contextFor(ClassLimitedController, 'addItem', 'a'));

    await expect(guard.canActivate(contextFor(ClassLimitedController, 'addItem', 'b'))).resolves.toBe(true);
  });

  it('uses the route key when it gives one, and falls back to the user or IP when it does not (#34)', async () => {
    const limiter = fakeLimiter();
    const guard = new RateLimitGuard(new Reflector(), limiter as unknown as RateLimiterService);
    const anonymous = (body: unknown) =>
      ({
        getClass: () => KeyedController,
        getHandler: () => KeyedController.prototype.refresh,
        // Every anonymous caller behind the gateway shares the gateway's IP.
        switchToHttp: () => ({ getRequest: () => ({ body, ip: '10.0.0.2', route: { path: '/refresh' } }) }),
      }) as unknown as ExecutionContext;

    await expect(guard.canActivate(anonymous({ session: 's1' }))).resolves.toBe(true);
    await expect(guard.canActivate(anonymous({ session: 's2' }))).resolves.toBe(true);
    await expect(guard.canActivate(anonymous({ session: 's1' }))).rejects.toMatchObject({ statusCode: 429 });
    await guard.canActivate(anonymous({}));

    expect(limiter.incrementAndCheck.mock.calls.map(([key]) => key)).toEqual([
      'ratelimit:/refresh:s1',
      'ratelimit:/refresh:s2',
      'ratelimit:/refresh:s1',
      'ratelimit:/refresh:10.0.0.2',
    ]);
  });

  it('counts anonymous callers by the client IP the gateway forwarded, never by a header without the marker (#203)', async () => {
    const limiter = fakeLimiter();
    const guard = new RateLimitGuard(new Reflector(), limiter as unknown as RateLimiterService);
    const anonymous = (headers: Record<string, string>) =>
      ({
        getClass: () => ClassLimitedController,
        getHandler: () => ClassLimitedController.prototype.addItem,
        switchToHttp: () => ({ getRequest: () => ({ headers, ip: '10.0.0.2', route: { path: '/addItem' } }) }),
      }) as unknown as ExecutionContext;

    await guard.canActivate(anonymous({ 'x-delivery-plus-gateway': '1', 'x-delivery-plus-client-ip': '203.0.113.7' }));
    await guard.canActivate(anonymous({ 'x-delivery-plus-client-ip': '203.0.113.8' }));

    expect(limiter.incrementAndCheck.mock.calls.map(([key]) => key)).toEqual(['ratelimit:/addItem:203.0.113.7', 'ratelimit:/addItem:10.0.0.2']);
  });

  it('does nothing when no limit is declared anywhere', async () => {
    const limiter = fakeLimiter();
    const guard = new RateLimitGuard(new Reflector(), limiter as unknown as RateLimiterService);

    await expect(guard.canActivate(contextFor(UnlimitedController, 'open'))).resolves.toBe(true);
    expect(limiter.incrementAndCheck).not.toHaveBeenCalled();
  });
});
