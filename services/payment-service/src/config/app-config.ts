export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  orderServiceUrl: string;
  paymentSuccessRate: number;
  /** How often owed payment side effects (events, order updates) are finished; 0 turns the sweep off (#56). */
  sideEffectsSweepMs: number;
  /** #18: how long a PROCESSING claim protects itself; after that a retry may take it over. */
  processingTimeoutMs: number;
  /** #18: after this long in PROCESSING the sweep settles the payment as not charged (simulated gateway). */
  processingAbandonMs: number;
}

export function loadConfig(): AppConfig {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    serviceName: process.env.SERVICE_NAME || 'payment-service',
    port: parseInt(process.env.PORT || '3007', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL as string,
    jwtSecret: process.env.JWT_SECRET as string,
    orderServiceUrl: process.env.ORDER_SERVICE_URL || 'http://localhost:3006',
    paymentSuccessRate: parseFloat(process.env.PAYMENT_SUCCESS_RATE || '0.9'),
    sideEffectsSweepMs: parseInt(process.env.PAYMENT_SIDE_EFFECTS_SWEEP_MS || '30000', 10),
    processingTimeoutMs: parseInt(process.env.PAYMENT_PROCESSING_TIMEOUT_MS || '60000', 10),
    processingAbandonMs: parseInt(process.env.PAYMENT_PROCESSING_ABANDON_MS || '900000', 10),
  };
}
