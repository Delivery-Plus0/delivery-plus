export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  cartServiceUrl: string;
  restaurantServiceUrl: string;
  userServiceUrl: string;
  internalAuthService: string;
  internalAuthSecret: string;
}

export function loadConfig(): AppConfig {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    serviceName: process.env.SERVICE_NAME || 'order-service',
    port: parseInt(process.env.PORT || '3006', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL as string,
    jwtSecret: process.env.JWT_SECRET as string,
    cartServiceUrl: process.env.CART_SERVICE_URL || 'http://localhost:3005',
    restaurantServiceUrl: process.env.RESTAURANT_SERVICE_URL || 'http://localhost:3003',
    userServiceUrl: process.env.USER_SERVICE_URL || 'http://localhost:3002',
    internalAuthService: process.env.INTERNAL_AUTH_SERVICE || 'order-service',
    internalAuthSecret: requireInternalAuthSecret(),
  };
}

function requireInternalAuthSecret(): string {
  const secret = process.env.INTERNAL_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('Missing required environment variables: INTERNAL_AUTH_SECRET');
  }
  return secret || 'local-internal-auth-development-only';
}
