import { loadSimulatorConfig } from './app-config';

describe('payment simulator configuration (#201)', () => {
  describe('production', () => {
    it('refuses to start with the simulator unless the closed-demo override is set', () => {
      expect(() => loadSimulatorConfig('production', {})).toThrow(/refuses to start in production/);
      expect(() => loadSimulatorConfig('production', { PAYMENT_SIMULATOR_IN_PRODUCTION: 'false' })).toThrow(/refuses to start in production/);
    });

    it('starts with the explicit override, flagged so startup warns loudly', () => {
      expect(loadSimulatorConfig('production', { PAYMENT_SIMULATOR_IN_PRODUCTION: 'true' })).toEqual({
        paymentSuccessRate: 1,
        paymentTestHooks: false,
        simulatorInProduction: true,
      });
    });

    it('never accepts the test hooks, even with the override', () => {
      expect(() =>
        loadSimulatorConfig('production', { PAYMENT_SIMULATOR_IN_PRODUCTION: 'true', PAYMENT_TEST_HOOKS: 'true' }),
      ).toThrow(/cannot run in production/);
    });
  });

  describe('test hooks and random declines', () => {
    it('defaults to hooks off and every payment succeeding', () => {
      expect(loadSimulatorConfig('development', {})).toEqual({ paymentSuccessRate: 1, paymentTestHooks: false, simulatorInProduction: false });
    });

    it('turns the hooks on only for the exact value true', () => {
      expect(loadSimulatorConfig('test', { PAYMENT_TEST_HOOKS: 'true' }).paymentTestHooks).toBe(true);
      expect(loadSimulatorConfig('test', { PAYMENT_TEST_HOOKS: '1' }).paymentTestHooks).toBe(false);
      expect(loadSimulatorConfig('test', { PAYMENT_TEST_HOOKS: 'yes' }).paymentTestHooks).toBe(false);
    });

    it('refuses a success rate below 1 without the hooks (no random declines outside tests)', () => {
      expect(() => loadSimulatorConfig('development', { PAYMENT_SUCCESS_RATE: '0.9' })).toThrow(/test setting/);
      expect(loadSimulatorConfig('development', { PAYMENT_SUCCESS_RATE: '1' }).paymentSuccessRate).toBe(1);
    });

    it('allows a lower success rate on a test stack', () => {
      expect(loadSimulatorConfig('test', { PAYMENT_TEST_HOOKS: 'true', PAYMENT_SUCCESS_RATE: '0.9' }).paymentSuccessRate).toBe(0.9);
    });

    it.each(['abc', '-0.1', '1.5'])('rejects an invalid success rate %s', (rate) => {
      expect(() => loadSimulatorConfig('test', { PAYMENT_TEST_HOOKS: 'true', PAYMENT_SUCCESS_RATE: rate })).toThrow(/from 0 to 1/);
    });
  });
});
