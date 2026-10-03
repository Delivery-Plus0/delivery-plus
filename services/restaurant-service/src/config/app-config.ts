export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  internalAuthSecret: string;
  internalAuthAllowedServices: string[];
}

export function loadConfig(): AppConfig {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    serviceName: process.env.SERVICE_NAME || 'restaurant-service',
    port: parseInt(process.env.PORT || '3003', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL as string,
    jwtSecret: process.env.JWT_SECRET as string,
    internalAuthSecret: requireInternalAuthSecret(),
    internalAuthAllowedServices: parseAllowedServices(
      process.env.INTERNAL_AUTH_ALLOWED_SERVICES || process.env.INTERNAL_AUTH_ALLOWED_SERVICE || 'menu-service,order-service',
    ),
  };
}

function parseAllowedServices(raw: string): string[] {
  return raw
    .split(',')
    .map((service) => service.trim())
    .filter(Boolean);
}

function requireInternalAuthSecret(): string {
  const secret = process.env.INTERNAL_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('Missing required environment variables: INTERNAL_AUTH_SECRET');
  }
  return secret || 'local-internal-auth-development-only';
}
