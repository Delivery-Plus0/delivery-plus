import { phoneVerificationRequired, loadSystemJwtSecret } from '@food-delivery/shared';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  /** #202: signs/verifies service-to-service SYSTEM tokens; required in production (see loadSystemJwtSecret). */
  systemJwtSecret: string;
  userServiceUrl: string;
  /** #153: going online needs a verified phone (off by default). */
  phoneVerificationRequired: boolean;
  /** #206 test hook: new driver profiles start VERIFIED. Never in production. */
  autoVerifyDrivers: boolean;
}

export function loadConfig(): AppConfig {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const nodeEnv = process.env.NODE_ENV || 'development';
  return {
    serviceName: process.env.SERVICE_NAME || 'driver-service',
    port: parseInt(process.env.PORT || '3009', 10),
    nodeEnv,
    databaseUrl: process.env.DATABASE_URL as string,
    jwtSecret: process.env.JWT_SECRET as string,
    systemJwtSecret: loadSystemJwtSecret(process.env.NODE_ENV || 'development'),
    userServiceUrl: process.env.USER_SERVICE_URL || 'http://localhost:3002',
    phoneVerificationRequired: phoneVerificationRequired(),
    ...loadVerificationConfig(nodeEnv),
  };
}

/**
 * #206: only an admin-VERIFIED driver can go online. Until admin accounts exist (#216, #234), the
 * test, E2E and dev stacks have no way to verify the drivers their seeds register, so
 * DRIVER_AUTO_VERIFY=true makes new profiles start VERIFIED there. Like SMS_PROVIDER=test and
 * PAYMENT_TEST_HOOKS, it is refused in production.
 */
export function loadVerificationConfig(nodeEnv: string, env: NodeJS.ProcessEnv = process.env): Pick<AppConfig, 'autoVerifyDrivers'> {
  const autoVerifyDrivers = (env.DRIVER_AUTO_VERIFY ?? '').trim() === 'true';
  if (autoVerifyDrivers && nodeEnv === 'production') {
    throw new Error('DRIVER_AUTO_VERIFY=true is for isolated test environments and cannot run in production');
  }
  return { autoVerifyDrivers };
}
