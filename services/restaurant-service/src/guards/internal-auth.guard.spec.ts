import { ExecutionContext } from '@nestjs/common';
import { signInternalRequest } from '@food-delivery/shared';
import { InternalAuthGuard } from './internal-auth.guard';

describe('RestaurantService.InternalAuthGuard', () => {
  const config = {
    internalAuthSecret: 'test-secret',
    internalAuthAllowedServices: ['menu-service', 'order-service'],
  } as any;
  const redis = { set: jest.fn() };
  let guard: InternalAuthGuard;

  beforeEach(() => {
    redis.set.mockReset().mockResolvedValue('OK');
    guard = new InternalAuthGuard(config, redis as any);
  });

  function contextFor(request: Record<string, any>): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
  }

  function signedRequest(overrides: Record<string, any> = {}) {
    const request: any = {
      method: 'GET',
      path: '/restaurants/550e8400-e29b-41d4-a716-446655440000/ownership/11111111-1111-41d4-a716-446655440000',
      body: {},
      ...overrides,
      headers: {
        'x-internal-service': 'menu-service',
        'x-internal-timestamp': Math.floor(Date.now() / 1000).toString(),
        'x-internal-nonce': 'nonce-1',
        ...(overrides.headers ?? {}),
      },
    };
    request.headers['x-internal-signature'] = signInternalRequest({
      method: request.method,
      path: request.path,
      timestamp: request.headers['x-internal-timestamp'],
      nonce: request.headers['x-internal-nonce'],
      body: request.body,
      service: request.headers['x-internal-service'],
      secret: config.internalAuthSecret,
    });
    return request;
  }

  it('accepts a valid internal service request for allowed callers', async () => {
    const request = signedRequest();
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.internalService).toBe('menu-service');
    expect(redis.set).toHaveBeenCalledWith(
      'internal-auth:nonce:menu-service:nonce-1',
      '1',
      'EX',
      600,
      'NX',
    );
  });

  it('rejects an untrusted internal service identity', async () => {
    await expect(
      guard.canActivate(contextFor(signedRequest({ headers: { 'x-internal-service': 'billing-service' } }))),
    ).rejects.toThrow('Invalid internal service credentials');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects a public request without internal credentials', async () => {
    await expect(
      guard.canActivate(contextFor({
        method: 'GET',
        path: '/restaurants/550e8400-e29b-41d4-a716-446655440000/ownership/11111111-1111-41d4-a716-446655440000',
        body: {},
        headers: {},
      })),
    ).rejects.toThrow('Invalid internal service credentials');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects a path changed after signing', async () => {
    const request = signedRequest();
    request.path = '/restaurants/550e8400-e29b-41d4-a716-446655440001/ownership/11111111-1111-41d4-a716-446655440000';
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      'Invalid internal service signature',
    );
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects an expired timestamp', async () => {
    const request = signedRequest({
      headers: { 'x-internal-timestamp': (Math.floor(Date.now() / 1000) - 301).toString() },
    });
    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      'Expired internal service credentials',
    );
    expect(redis.set).not.toHaveBeenCalled();
  });
});
