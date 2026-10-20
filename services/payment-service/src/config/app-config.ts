export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  serviceName: string;
  port: number;
  nodeEnv: string;
  databaseUrl: string;
  jwtSecret: string;
  orderServiceUrl: string;
  /** Share of simulated payments that succeed. Always 1 unless test hooks are on (#201). */
  paymentSuccessRate: number;
  /** #201: accept the `simulateFailure` test hook on POST /payments/:id/process. Test stacks only. */
  paymentTestHooks: boolean;
  /** #201: production is running the simulated provider on purpose (closed demo); startup warns loudly. */
  simulatorInProduction: boolean;
  /** How often owed payment side effects (events, order updates) are finished; 0 turns the sweep off (#56). */
  sideEffectsSweepMs: number;
  /** #18: how long a PROCESSING claim protects itself; after that a retry may take it over. */
  processingTimeoutMs: number;
  /** #18: after this long in PROCESSING the sweep settles the payment as not charged (simulated gateway). */
  processingAbandonMs: number;
}

const isTrue = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'true';

/**
 * #201: the payment provider is a simulator, so:
 * - production refuses to start with it unless PAYMENT_SIMULATOR_IN_PRODUCTION=true (a closed demo),
 *   until a real provider exists (#224);
 * - the `simulateFailure` test hook and random declines (PAYMENT_SUCCESS_RATE < 1) need
 *   PAYMENT_TEST_HOOKS=true, which only the test and E2E Compose stacks set, and never production.
 * Modeled on user-service's SMS_PROVIDER=test guard.
 */
export function loadSimulatorConfig(
  nodeEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): Pick<AppConfig, 'paymentSuccessRate' | 'paymentTestHooks' | 'simulatorInProduction'> {
  const paymentTestHooks = isTrue(env.PAYMENT_TEST_HOOKS);
  const simulatorAllowed = isTrue(env.PAYMENT_SIMULATOR_IN_PRODUCTION);
  if (nodeEnv === 'production') {
    if (paymentTestHooks) {
      throw new Error('PAYMENT_TEST_HOOKS=true is for isolated test environments and cannot run in production');
    }
    if (!simulatorAllowed) {
      throw new Error(
        'payment-service only has a simulated payment provider and refuses to start in production. ' +
          'Set PAYMENT_SIMULATOR_IN_PRODUCTION=true only for a closed demo.',
      );
    }
  }

  const rawRate = env.PAYMENT_SUCCESS_RATE?.trim();
  const paymentSuccessRate = rawRate ? Number(rawRate) : 1;
  if (!Number.isFinite(paymentSuccessRate) || paymentSuccessRate < 0 || paymentSuccessRate > 1) {
    throw new Error(`PAYMENT_SUCCESS_RATE must be a number from 0 to 1, got "${rawRate}"`);
  }
  if (paymentSuccessRate !== 1 && !paymentTestHooks) {
    throw new Error(
      'PAYMENT_SUCCESS_RATE below 1 declines payments at random, which is a test setting: ' +
        'leave it unset, or set PAYMENT_TEST_HOOKS=true on a test stack',
    );
  }

  return { paymentSuccessRate, paymentTestHooks, simulatorInProduction: nodeEnv === 'production' && simulatorAllowed };
}

export function loadConfig(): AppConfig {
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const nodeEnv = process.env.NODE_ENV || 'development';
  return {
    serviceName: process.env.SERVICE_NAME || 'payment-service',
    port: parseInt(process.env.PORT || '3007', 10),
    nodeEnv,
    databaseUrl: process.env.DATABASE_URL as string,
    jwtSecret: process.env.JWT_SECRET as string,
    orderServiceUrl: process.env.ORDER_SERVICE_URL || 'http://localhost:3006',
    ...loadSimulatorConfig(nodeEnv),
    sideEffectsSweepMs: parseInt(process.env.PAYMENT_SIDE_EFFECTS_SWEEP_MS || '30000', 10),
    processingTimeoutMs: parseInt(process.env.PAYMENT_PROCESSING_TIMEOUT_MS || '60000', 10),
    processingAbandonMs: parseInt(process.env.PAYMENT_PROCESSING_ABANDON_MS || '900000', 10),
  };
}
