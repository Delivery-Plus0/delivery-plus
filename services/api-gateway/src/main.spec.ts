// http-proxy-middleware v4 ships ESM only. Node loads it from the compiled
// CommonJS gateway (require(esm)), but Jest's own CommonJS module runtime
// cannot parse it. These tests cover main.ts's pure helpers and never start the
// proxy, so stub the module rather than load it.
jest.mock('http-proxy-middleware', () => ({ createProxyMiddleware: jest.fn() }));

import {
  extractPathParameters,
  generatePublicOpenApiDocument,
  joinPublicPath,
  validatePublicOpenApiDocument,
  generateAdminOpenApiDocument,
  validateAdminOpenApiDocument,
} from './public-openapi';
import { isBlockedInternalRoute } from './route-policy';
import { getCorsOptions, getServicePrefix, PROXIES, rewriteProxyPath } from './main';

describe('gateway browser CORS', () => {
  it('allows the idempotency header used by order and payment clients', () => {
    expect(getCorsOptions().allowedHeaders).toContain('Idempotency-Key');
  });

  describe('production origin enforcement', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalCorsOrigins = process.env.CORS_ORIGINS;

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
      process.env.CORS_ORIGINS = originalCorsOrigins;
    });

    it('throws when NODE_ENV=production and CORS_ORIGINS is missing', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ORIGINS;

      expect(() => getCorsOptions()).toThrow(/CORS_ORIGINS/);
    });

    it('throws when NODE_ENV=production and CORS_ORIGINS is set but empty after trimming', () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = ' , ,';

      expect(() => getCorsOptions()).toThrow(/CORS_ORIGINS/);
    });

    it('uses the configured origins when NODE_ENV=production and CORS_ORIGINS is set', () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = 'https://app.example.com,https://admin.example.com';

      expect(getCorsOptions().origin).toEqual([
        'https://app.example.com',
        'https://admin.example.com',
      ]);
    });

    it('parses multiple comma-separated origins and trims whitespace', () => {
      process.env.NODE_ENV = 'production';
      process.env.CORS_ORIGINS = ' https://a.example.com , https://b.example.com ,https://c.example.com';

      expect(getCorsOptions().origin).toEqual([
        'https://a.example.com',
        'https://b.example.com',
        'https://c.example.com',
      ]);
    });

    it('still falls back to the localhost defaults outside production when CORS_ORIGINS is unset', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.CORS_ORIGINS;

      expect(getCorsOptions().origin).toEqual([
        'http://localhost:8081',
        'http://localhost:8082',
        'http://localhost:8083',
        'http://localhost:8084',
        'http://localhost:8085',
        'http://127.0.0.1:8081',
        'http://127.0.0.1:8082',
        'http://127.0.0.1:8083',
        'http://127.0.0.1:8084',
        'http://127.0.0.1:8085',
      ]);
    });
  });
});

describe('gateway internal route exposure', () => {
  it('blocks the internal users route from public proxying', () => {
    expect(isBlockedInternalRoute('/api/users/internal')).toBe(true);
    // #212: admin routes have one way in, /api/admin/<service>.
    expect(isBlockedInternalRoute('/api/menus/admin')).toBe(true);
    expect(isBlockedInternalRoute('/api/menus/admin/menu-items/abc')).toBe(true);
    expect(isBlockedInternalRoute('/api/menus/restaurants/abc/menu')).toBe(false);
    expect(isBlockedInternalRoute('/api/admin/menus/menu-items/abc')).toBe(false);
    expect(isBlockedInternalRoute('/api/users/internal/profile')).toBe(true);
    expect(isBlockedInternalRoute('/api/users/Internal')).toBe(true);
    expect(isBlockedInternalRoute('/api/users/INTERNAL/users')).toBe(true);
    expect(isBlockedInternalRoute('/internal/users')).toBe(true);
  });

  it('does not block normal user routes', () => {
    expect(isBlockedInternalRoute('/api/users/me')).toBe(false);
    expect(isBlockedInternalRoute('/api/users')).toBe(false);
  });

  it('blocks public ownership-verification probes through the gateway', () => {
    expect(
      isBlockedInternalRoute('/api/restaurants/550e8400-e29b-41d4-a716-446655440000/ownership/11111111-1111-41d4-a716-446655440000'),
    ).toBe(true);
    expect(isBlockedInternalRoute('/api/restaurants/me')).toBe(false);
    expect(isBlockedInternalRoute('/api/restaurants')).toBe(false);
  });

  it("blocks the services-only restaurant contact route through the gateway (#211)", () => {
    expect(isBlockedInternalRoute('/api/restaurants/550e8400-e29b-41d4-a716-446655440000/contact')).toBe(true);
    expect(isBlockedInternalRoute('/API/Restaurants/550e8400-e29b-41d4-a716-446655440000/Contact/')).toBe(true);
    expect(isBlockedInternalRoute('/api/restaurants/550e8400-e29b-41d4-a716-446655440000/contact-us')).toBe(false);
    const document = generatePublicOpenApiDocument();
    expect(document.paths['/api/restaurants/{id}/contact']).toBeUndefined();
  });

  it('exposes owner restaurant selection and hides the internal ownership oracle', () => {
    const document = generatePublicOpenApiDocument();
    expect(document.paths['/api/restaurants/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths['/api/restaurants/{id}/ownership/{userId}']).toBeUndefined();
  });

  it('documents restaurant location filtering, admin radius updates, and out-of-area checkout errors', () => {
    const document = generatePublicOpenApiDocument();

    expect(document.paths['/api/restaurants'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'lat', in: 'query' }),
        expect.objectContaining({ name: 'lng', in: 'query' }),
      ]),
    );
    expect(document.paths['/api/restaurants/{id}/delivery-radius'].patch.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths['/api/restaurants/{id}/delivery-radius'].patch.requestBody.content[
      'application/json'
    ].schema.$ref).toBe('#/components/schemas/UpdateDeliveryRadiusRequest');
    expect(
      document.paths['/api/orders'].post.responses['409'].content['application/json'].schema.oneOf,
    ).toEqual(
      expect.arrayContaining([
        { $ref: '#/components/schemas/CartChangedError' },
        { $ref: '#/components/schemas/OutOfDeliveryAreaError' },
      ]),
    );
  });

  it('rewrites public auth routes to the downstream service route', () => {
    expect(rewriteProxyPath('/api/auth', '/register')).toBe('/auth/register');
    expect(rewriteProxyPath('/api/auth', '/login')).toBe('/auth/login');
    expect(rewriteProxyPath('/api/auth', '/verify-email')).toBe('/auth/verify-email');
    expect(rewriteProxyPath('/api/auth', '/me')).toBe('/auth/me');
  });

  it('preserves restaurant list query parameters while restoring the downstream route prefix', () => {
    expect(rewriteProxyPath('/api/restaurants', '/?lat=30.0444&lng=31.2357')).toBe(
      '/restaurants/?lat=30.0444&lng=31.2357',
    );
  });

  it('rewrites user routes without double-prefixing', () => {
    expect(getServicePrefix('/api/users')).toBe('/users');
    expect(rewriteProxyPath('/api/users', '/me')).toBe('/users/me');
    expect(rewriteProxyPath('/api/users', '/123')).toBe('/users/123');
  });

  it('rewrites admin routes to the service /admin route space (#212)', () => {
    expect(getServicePrefix('/api/admin/orders')).toBe('/admin/orders');
    expect(rewriteProxyPath('/api/admin/orders', '/')).toBe('/admin/orders/');
    expect(rewriteProxyPath('/api/admin/orders', '/?page=2&limit=50')).toBe('/admin/orders/?page=2&limit=50');
    expect(rewriteProxyPath('/api/admin/orders', '/abc')).toBe('/admin/orders/abc');
    expect(Object.keys(PROXIES).filter((p) => p.startsWith('/api/admin/')).length).toBe(12);
  });

  it('preserves menu-service root routes and swagger-json rewrite behavior', () => {
    expect(getServicePrefix('/api/menus')).toBe('');
    expect(rewriteProxyPath('/api/menus', '/restaurants/abc/menu')).toBe('/restaurants/abc/menu');
    expect(rewriteProxyPath('/api/menus', '/docs-json')).toBe('/docs-json');
    expect(rewriteProxyPath('/api/auth', '/docs-json')).toBe('/docs-json');
    expect(rewriteProxyPath('/api/auth', '/docs-json?cache=1')).toBe('/docs-json?cache=1');
    expect(rewriteProxyPath('/api/auth', '/docs-json/subpath')).toBe('/docs-json');
    expect(rewriteProxyPath('/api/auth', '/docs-json/subpath?cache=1')).toBe('/docs-json?cache=1');
  });

  it('converts Express-style path params into OpenAPI path templates', () => {
    expect(joinPublicPath('/api/users', '/:id')).toBe('/api/users/{id}');
    expect(joinPublicPath('/api/restaurants', '/:restaurantId/menu/:menuItemId')).toBe(
      '/api/restaurants/{restaurantId}/menu/{menuItemId}',
    );
  });

  it('extracts required path parameters and ignores duplicates', () => {
    expect(extractPathParameters('/api/users/{id}/orders/{orderId}')).toEqual(['id', 'orderId']);
    expect(extractPathParameters('/api/users/:id')).toEqual(['id']);
  });

  it('validates path syntax and parameter definitions', () => {
    const validDoc = {
      openapi: '3.0.3',
      servers: [{ url: 'http://localhost:3000' }],
      paths: {
        '/api/users/{id}': {
          get: {
            operationId: 'users_get_user',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
      tags: [{ name: 'users' }],
    };

    expect(() => validatePublicOpenApiDocument(validDoc, ['/api/users'])).not.toThrow();
    expect(() =>
      validatePublicOpenApiDocument(
        {
          ...validDoc,
          paths: {
            '/api/users/:id': {
              get: {
                operationId: 'users_get_user',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        },
        ['/api/users'],
      ),
    ).toThrow(/Express-style.*:id|path.*:id/i);
    expect(() =>
      validatePublicOpenApiDocument(
        {
          ...validDoc,
          paths: {
            '/api/cartography': {
              get: {
                operationId: 'cartography_get',
                responses: { '200': { description: 'ok' } },
              },
            },
          },
        },
        ['/api/cart'],
      ),
    ).toThrow(/service prefix|\/api\/cart/i);
  });

  it('includes authenticated media upload and confirmation operations in the public contract', () => {
    const document = generatePublicOpenApiDocument();
    const mediaPaths = [
      '/api/users/me/avatar/image-upload-url',
      '/api/users/me/avatar/confirm',
      '/api/restaurants/{id}/image-upload-url',
      '/api/restaurants/{id}/image-confirm',
      '/api/menus/menu-items/{id}/image-upload-url',
      '/api/menus/menu-items/{id}/image-confirm',
    ];

    for (const path of mediaPaths) {
      const operation = document.paths[path].post;
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(operation.requestBody.required).toBe(true);
    }
    expect(document.paths['/api/users/me/avatar/image-upload-url'].post.responses['201'].content)
      .toBeDefined();
  });
});
describe('admin OpenAPI contract (#212)', () => {
  it('documents each admin route with its own parameters and permissions', () => {
    const doc = generateAdminOpenApiDocument();
    expect(() => validateAdminOpenApiDocument(doc)).not.toThrow();
    const list = doc.paths['/api/admin/orders'].get;
    expect(list['x-permissions']).toEqual(['support.read']);
    expect(list.parameters.map((p: { name: string }) => p.name)).toEqual(
      expect.arrayContaining(['page', 'limit', 'q', 'id', 'customerId', 'restaurantId', 'status', 'sort']),
    );
  });

  it('rejects an admin route without permissions, and a mutation without a reason', () => {
    const doc = generateAdminOpenApiDocument();
    const withoutPerms = JSON.parse(JSON.stringify(doc));
    delete withoutPerms.paths['/api/admin/orders'].get['x-permissions'];
    expect(() => validateAdminOpenApiDocument(withoutPerms)).toThrow('declare its staff permissions');

    const withMutation = JSON.parse(JSON.stringify(doc));
    withMutation.paths['/api/admin/orders/{id}/cancel'] = {
      post: {
        ...doc.paths['/api/admin/orders'].get,
        operationId: 'admin_orders_post_cancel',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { note: { type: 'string' } } } } } },
      },
    };
    expect(() => validateAdminOpenApiDocument(withMutation)).toThrow('must require a reason');

    const unaudited = JSON.parse(JSON.stringify(withMutation));
    unaudited.paths['/api/admin/orders/{id}/cancel'].post.requestBody.content['application/json'].schema = {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string' } },
    };
    expect(() => validateAdminOpenApiDocument(unaudited)).toThrow('name the audit action');
    unaudited.paths['/api/admin/orders/{id}/cancel'].post['x-audit-action'] = 'order.cancel';
    expect(() => validateAdminOpenApiDocument(unaudited)).not.toThrow();

    // #214: a read-only POST (a search with the value in the body) needs neither.
    expect(doc.paths['/api/admin/users/search'].post['x-read-only']).toBe(true);
    expect(doc.paths['/api/admin/users/search'].post.requestBody.content['application/json'].schema.required).toBeUndefined();
  });

  it('lists every admin mutation with the audit action it records (#213, #215)', () => {
    const doc = generateAdminOpenApiDocument();
    const mutations = Object.entries(doc.paths as Record<string, Record<string, Record<string, unknown>>>)
      .flatMap(([path, operations]) => Object.entries(operations).map(([method, operation]) => ({ route: `${method.toUpperCase()} ${path}`, operation })))
      .filter(({ route, operation }) => !route.startsWith('GET ') && operation['x-read-only'] !== true)
      .map(({ route, operation }) => `${route} -> ${operation['x-audit-action']}`)
      .sort();
    expect(mutations).toEqual(
      [
        'PATCH /api/admin/auth/staff/{id}/permissions -> staff.permissions_change',
        'POST /api/admin/auth/staff/invitations -> staff.invite',
        'POST /api/admin/auth/staff/{id}/disable -> staff.disable',
        'POST /api/admin/auth/staff/{id}/enable -> staff.enable',
        'POST /api/admin/auth/users/{id}/reactivate -> user.reactivate',
        'POST /api/admin/auth/users/{id}/revoke-sessions -> user.revoke_sessions',
        'POST /api/admin/auth/users/{id}/suspend -> user.suspend',
        'POST /api/admin/drivers/{id}/reactivate -> driver.reactivate',
        'POST /api/admin/drivers/{id}/review -> driver.approve',
        'POST /api/admin/drivers/{id}/suspend -> driver.suspend',
        'POST /api/admin/restaurants/{id}/reactivate -> restaurant.reactivate',
        'POST /api/admin/restaurants/{id}/review -> restaurant.approve',
        'POST /api/admin/restaurants/{id}/suspend -> restaurant.suspend',
      ].sort(),
    );
  });

  it('keeps admin paths out of the public contract', () => {
    const doc = generatePublicOpenApiDocument();
    expect(Object.keys(doc.paths).some((path) => path.startsWith('/api/admin/'))).toBe(false);
  });
});
