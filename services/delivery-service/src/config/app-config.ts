export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  orderServiceUrl: string;
  driverServiceUrl: string;
  restaurantServiceUrl: string;
  /** How often auto-dispatch retries deliveries waiting for a driver; 0 disables the retry. */
  autoDispatchSweepMs: number;
}

export function loadConfig(): AppConfig {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    serviceName: process.env.SERVICE_NAME || 'delivery-service',
    port: parseInt(process.env.PORT || '3008', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL as string,
    jwtSecret: process.env.JWT_SECRET as string,
    orderServiceUrl: process.env.ORDER_SERVICE_URL || 'http://localhost:3006',
    driverServiceUrl: process.env.DRIVER_SERVICE_URL || 'http://localhost:3009',
    restaurantServiceUrl: process.env.RESTAURANT_SERVICE_URL || 'http://localhost:3003',
    autoDispatchSweepMs: parseInt(process.env.AUTO_DISPATCH_SWEEP_MS || '15000', 10),
  };
}
