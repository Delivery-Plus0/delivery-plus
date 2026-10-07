import { phoneVerificationRequired } from '@food-delivery/shared';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  userServiceUrl: string;
  /** #153: going online needs a verified phone (off by default). */
  phoneVerificationRequired: boolean;
}

export function loadConfig(): AppConfig {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    serviceName: process.env.SERVICE_NAME || 'driver-service',
    port: parseInt(process.env.PORT || '3009', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL as string,
    jwtSecret: process.env.JWT_SECRET as string,
    userServiceUrl: process.env.USER_SERVICE_URL || 'http://localhost:3002',
    phoneVerificationRequired: phoneVerificationRequired(),
  };
}
