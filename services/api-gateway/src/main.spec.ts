import {
  extractPathParameters,
  generatePublicOpenApiDocument,
  joinPublicPath,
  validatePublicOpenApiDocument,
} from './public-openapi';
import { isBlockedInternalRoute } from './route-policy';
import { getCorsOptions, getServicePrefix, rewriteProxyPath } from './main';

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
        'http://127.0.0.1:8081',
        'http://127.0.0.1:8082',
        'http://127.0.0.1:8083',
      ]);
    });
  });
});

describe('gateway internal route exposure', () => {
  it('blocks the internal users route from public proxying', () => {
    expect(isBlockedInternalRoute('/api/users/internal')).toBe(true);
    expect(isBlockedInternalRoute('/api/users/internal/profile')).toBe(true);
    expect(isBlockedInternalRoute('/api/users/Internal')).toBe(true);
    expect(isBlockedInternalRoute('/api/users/INTERNAL/users')).toBe(true);
    expect(isBlockedInternalRoute('/internal/users')).toBe(true);
  });

  it('does not block normal user routes', () => {
    expect(isBlockedInternalRoute('/api/users/me')).toBe(false);
    expect(isBlockedInternalRoute('/api/users')).toBe(false);
  });

  it('rewrites public auth routes to the downstream service route', () => {
    expect(rewriteProxyPath('/api/auth', '/register')).toBe('/auth/register');
    expect(rewriteProxyPath('/api/auth', '/login')).toBe('/auth/login');
    expect(rewriteProxyPath('/api/auth', '/verify-email')).toBe('/auth/verify-email');
    expect(rewriteProxyPath('/api/auth', '/me')).toBe('/auth/me');
  });

  it('rewrites user routes without double-prefixing', () => {
    expect(getServicePrefix('/api/users')).toBe('/users');
    expect(rewriteProxyPath('/api/users', '/me')).toBe('/users/me');
    expect(rewriteProxyPath('/api/users', '/123')).toBe('/users/123');
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