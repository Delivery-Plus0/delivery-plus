import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { SwaggerModule } from '@nestjs/swagger';
import { NextFunction, Request, Response } from 'express';
import { isBlockedInternalRoute } from './route-policy';

export const PROXIES = {
  '/api/auth': process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
  '/api/users': process.env.USER_SERVICE_URL || 'http://localhost:3002',
  '/api/restaurants': process.env.RESTAURANT_SERVICE_URL || 'http://localhost:3003',
  '/api/menus': process.env.MENU_SERVICE_URL || 'http://localhost:3004',
  '/api/cart': process.env.CART_SERVICE_URL || 'http://localhost:3005',
  '/api/orders': process.env.ORDER_SERVICE_URL || 'http://localhost:3006',
  '/api/payments': process.env.PAYMENT_SERVICE_URL || 'http://localhost:3007',
  '/api/deliveries': process.env.DELIVERY_SERVICE_URL || 'http://localhost:3008',
  '/api/drivers': process.env.DRIVER_SERVICE_URL || 'http://localhost:3009',
  '/api/tracking': process.env.TRACKING_SERVICE_URL || 'http://localhost:3010',
  '/api/notifications': process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3011',
} as const;

export function getServicePrefix(gatewayPath: string): string {
  return gatewayPath === '/api/menus'
    ? ''
    : gatewayPath.replace(/^\/api/, '');
}

export function rewriteProxyPath(
  gatewayPath: string,
  incomingPath: string,
): string {
  const [pathname, queryString = ''] = incomingPath.split('?');

  if (/^\/docs-json(?:\/|$)/.test(pathname)) {
    return `/docs-json${queryString ? `?${queryString}` : ''}`;
  }

  return `${getServicePrefix(gatewayPath)}${incomingPath}`;
}

function getCorsOrigins(): string[] {
  const rawOrigins = process.env.CORS_ORIGINS;

  if (!rawOrigins) {
    return [
      'http://localhost:8081',
      'http://localhost:8082',
      'http://localhost:8083',
      'http://127.0.0.1:8081',
      'http://127.0.0.1:8082',
      'http://127.0.0.1:8083',
    ];
  }

  return rawOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function getCorsOptions() {
  return {
    origin: getCorsOrigins(),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Correlation-Id',
      'Idempotency-Key',
    ],
  };
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const PORT = process.env.PORT || 3000;

  app.enableCors(getCorsOptions());

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (isBlockedInternalRoute(request.path)) {
      response.status(404).json({
        statusCode: 404,
        message: 'Not Found',
      });
      return;
    }

    next();
  });

  const swaggerOptions = {
    explorer: true,
    urls: Object.keys(PROXIES).map((path) => ({
      url: `${path}/docs-json`,
      name: path.replace('/api/', '').toUpperCase() + ' API',
    })),
  };

  SwaggerModule.setup('docs', app, null as any, {
    explorer: true,
    swaggerOptions,
    customSiteTitle: 'Food Delivery API Gateway Docs',
  });

  Object.entries(PROXIES).forEach(([path, target]) => {
    app.use(
      path,
      createProxyMiddleware({
        target,
        changeOrigin: true,
        pathRewrite: (incomingPath) =>
          rewriteProxyPath(path, incomingPath),
      }),
    );
  });

  await app.listen(PORT);

  console.log(`API Gateway running on port ${PORT}`);
  console.log(`Swagger UI available at http://localhost:${PORT}/docs`);
}

if (require.main === module) {
  bootstrap();
}