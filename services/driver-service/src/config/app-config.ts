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
  /** #207: rate limits on document uploads and staff reads. */
  redisUrl: string;
  /** #207: the private bucket for driver documents. Never the public media bucket. */
  documentsBucket: string;
  /** #207: keys the HMAC that detects a national ID registered twice without storing the number. */
  nationalIdHmacSecret: string;
  /** #207: how often the licence expiry check runs (ms); 0 turns it off. */
  licenceExpiryCheckIntervalMs: number;
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
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    ...loadDocumentConfig(nodeEnv),
    licenceExpiryCheckIntervalMs: loadLicenceExpiryInterval(),
  };
}

const HOUR_MS = 60 * 60 * 1000;

/** #207: DRIVER_LICENCE_EXPIRY_CHECK_MS, hourly by default; 0 turns the check off, anything else invalid is refused. */
export function loadLicenceExpiryInterval(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.DRIVER_LICENCE_EXPIRY_CHECK_MS ?? '').trim();
  if (!raw) return HOUR_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || (value !== 0 && value < 60_000)) {
    throw new Error('DRIVER_LICENCE_EXPIRY_CHECK_MS must be 0 (off) or a whole number of milliseconds of at least 60000');
  }
  return value;
}

/** Local development and the test suites only; a production-like environment must set its own. */
export const LOCAL_NATIONAL_ID_HMAC_SECRET = 'local-national-id-hmac-development-only';
export const LOCAL_DOCUMENTS_BUCKET = 'delivery-plus-private';
const MIN_PRODUCTION_SECRET_LENGTH = 32;
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * #207: driver documents live in their own private bucket, never the public media one, and the service
 * refuses to start in production without it. The national ID HMAC secret has no default outside
 * development and test: a guessable key would let anyone with the database test candidate numbers
 * against the stored hashes.
 */
export function loadDocumentConfig(
  nodeEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): Pick<AppConfig, 'documentsBucket' | 'nationalIdHmacSecret'> {
  const localDefaults = nodeEnv === 'development' || nodeEnv === 'test';

  const bucket = (env.DRIVER_DOCUMENTS_BUCKET ?? '').trim();
  if (!bucket && nodeEnv === 'production') {
    throw new Error('Missing required environment variables: DRIVER_DOCUMENTS_BUCKET');
  }
  const documentsBucket = bucket || LOCAL_DOCUMENTS_BUCKET;
  if (!BUCKET_NAME.test(documentsBucket)) {
    throw new Error('DRIVER_DOCUMENTS_BUCKET is not a valid bucket name');
  }
  if (env.AWS_S3_BUCKET && documentsBucket === env.AWS_S3_BUCKET.trim()) {
    throw new Error('DRIVER_DOCUMENTS_BUCKET must not be the public media bucket (AWS_S3_BUCKET)');
  }

  const secret = env.NATIONAL_ID_HMAC_SECRET;
  if (!secret) {
    if (!localDefaults) throw new Error('Missing required environment variables: NATIONAL_ID_HMAC_SECRET');
    return { documentsBucket, nationalIdHmacSecret: LOCAL_NATIONAL_ID_HMAC_SECRET };
  }
  if (!localDefaults) {
    if (secret === LOCAL_NATIONAL_ID_HMAC_SECRET) {
      throw new Error('NATIONAL_ID_HMAC_SECRET is the local development default; set a real secret');
    }
    if (secret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      throw new Error(`NATIONAL_ID_HMAC_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters`);
    }
    if (secret === env.JWT_SECRET || secret === env.SYSTEM_JWT_SECRET) {
      throw new Error('NATIONAL_ID_HMAC_SECRET must differ from the JWT secrets');
    }
  }
  return { documentsBucket, nationalIdHmacSecret: secret };
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
