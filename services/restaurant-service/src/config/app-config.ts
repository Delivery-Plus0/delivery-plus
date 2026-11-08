import { loadSystemJwtSecret } from '@food-delivery/shared';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  internalAuthSecret: string;
  internalAuthAllowedServices: string[];
  defaultDeliveryRadiusKm: number;
  /** #208: submit reads the restaurant's menu from menu-service (at least one category and available item). */
  menuServiceUrl: string;
  /** #211: verifies delivery-service's SYSTEM token on the contact route; required in production. */
  systemJwtSecret: string;
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
    defaultDeliveryRadiusKm: parseDefaultDeliveryRadius(process.env.DEFAULT_DELIVERY_RADIUS_KM),
    menuServiceUrl: process.env.MENU_SERVICE_URL || 'http://localhost:3004',
    systemJwtSecret: loadSystemJwtSecret(process.env.NODE_ENV || 'development'),
  };
}

function parseDefaultDeliveryRadius(raw: string | undefined): number {
  const radiusKm = raw === undefined ? 5 : Number(raw);
  if (!Number.isFinite(radiusKm) || radiusKm < 0.01 || radiusKm > 50) {
    throw new Error('DEFAULT_DELIVERY_RADIUS_KM must be a number greater than 0 and at most 50');
  }
  return radiusKm;
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
