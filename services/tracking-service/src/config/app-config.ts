export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  redisUrl: string;
  locationTtlSeconds: number;
  /** A position older than this is reported as STALE, not LIVE (#32). Drivers report every 10 s. */
  locationStaleAfterSeconds: number;
  /** Realtime stream keepalive (SSE comment) interval (#135). */
  streamHeartbeatMs: number;
  /** Realtime stream full reload: re-authorizes and covers a lost pub/sub message (#135). */
  streamResyncMs: number;
  jwtSecret: string;
  deliveryServiceUrl: string;
  driverServiceUrl: string;
}

export function loadConfig(): AppConfig {
  const required = ['REDIS_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    serviceName: process.env.SERVICE_NAME || 'tracking-service',
    port: parseInt(process.env.PORT || '3010', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    redisUrl: process.env.REDIS_URL as string,
    locationTtlSeconds: parseInt(process.env.LOCATION_TTL_SECONDS || '300', 10),
    locationStaleAfterSeconds: parseInt(process.env.LOCATION_STALE_AFTER_SECONDS || '60', 10),
    streamHeartbeatMs: parseInt(process.env.TRACKING_STREAM_HEARTBEAT_MS || '15000', 10),
    streamResyncMs: parseInt(process.env.TRACKING_STREAM_RESYNC_MS || '30000', 10),
    jwtSecret: process.env.JWT_SECRET as string,
    deliveryServiceUrl: process.env.DELIVERY_SERVICE_URL || 'http://localhost:3008',
    driverServiceUrl: process.env.DRIVER_SERVICE_URL || 'http://localhost:3009',
  };
}
