export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  orderServiceUrl: string;
  redisUrl: string;
  internalAuthSecret: string;
  internalAuthAllowedService: string;
  /** Phone verification (#153): `disabled` (default) until a real provider exists; `test` only outside production. */
  smsProvider: SmsProvider;
  /** Keys the stored code hashes; required in production once a provider is on. */
  otpHashSecret: string;
}

export type SmsProvider = 'disabled' | 'test';

export function loadConfig(): AppConfig {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    serviceName: process.env.SERVICE_NAME || 'user-service',
    port: parseInt(process.env.PORT || '3002', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL as string,
    jwtSecret: process.env.JWT_SECRET as string,
    orderServiceUrl: process.env.ORDER_SERVICE_URL || 'http://localhost:3006',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    internalAuthSecret: requireInternalAuthSecret(),
    internalAuthAllowedService: process.env.INTERNAL_AUTH_ALLOWED_SERVICE || 'auth-service',
    ...loadSmsConfig(process.env.NODE_ENV || 'development'),
  };
}

export function loadSmsConfig(nodeEnv: string): Pick<AppConfig, 'smsProvider' | 'otpHashSecret'> {
  const provider = (process.env.SMS_PROVIDER || 'disabled').trim().toLowerCase();
  if (provider !== 'disabled' && provider !== 'test') {
    throw new Error(`Unsupported SMS_PROVIDER "${provider}": use "disabled" until a real provider is added`);
  }
  if (provider === 'test' && nodeEnv === 'production') {
    throw new Error('SMS_PROVIDER=test is for isolated test environments and cannot run in production');
  }
  const secret = process.env.OTP_HASH_SECRET;
  if (!secret && nodeEnv === 'production' && provider !== 'disabled') {
    throw new Error('Missing required environment variables: OTP_HASH_SECRET');
  }
  return { smsProvider: provider, otpHashSecret: secret || 'local-otp-development-only' };
}

function requireInternalAuthSecret(): string {
  const secret = process.env.INTERNAL_AUTH_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('Missing required environment variables: INTERNAL_AUTH_SECRET');
  }
  return secret || 'local-internal-auth-development-only';
}
