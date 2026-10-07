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
  /** user-service, for the customer-safe driver card (display name, photo) (#140). */
  userServiceUrl: string;
  /** How often auto-dispatch retries deliveries waiting for a driver; 0 disables the retry. */
  autoDispatchSweepMs: number;
  /** Hours a delivery earning stays PENDING before it is AVAILABLE (#145). */
  earningsSettlementHours: number;
  /** How often due earnings are settled; 0 disables the sweep (reads still settle). */
  earningsSettleSweepMs: number;
  /** How often drivers left BUSY after a finished delivery are released; 0 disables it (#98). */
  driverReconcileSweepMs: number;
  /** A BUSY driver whose status changed more recently than this is left alone (may be mid-assignment). */
  driverReconcileGraceMs: number;
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
    userServiceUrl: process.env.USER_SERVICE_URL || 'http://localhost:3002',
    autoDispatchSweepMs: parseInt(process.env.AUTO_DISPATCH_SWEEP_MS || '15000', 10),
    earningsSettlementHours: settlementHours(process.env.EARNINGS_SETTLEMENT_HOURS),
    earningsSettleSweepMs: parseInt(process.env.EARNINGS_SETTLE_SWEEP_MS || '60000', 10),
    driverReconcileSweepMs: parseInt(process.env.DRIVER_RECONCILE_SWEEP_MS || '60000', 10),
    driverReconcileGraceMs: parseInt(process.env.DRIVER_RECONCILE_GRACE_MS || '60000', 10),
  };
}

/** EARNINGS_SETTLEMENT_HOURS (#145): default 12, as decided; must be a non-negative number. */
function settlementHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 12;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) throw new Error(`EARNINGS_SETTLEMENT_HOURS must be a non-negative number, got "${raw}"`);
  return hours;
}
