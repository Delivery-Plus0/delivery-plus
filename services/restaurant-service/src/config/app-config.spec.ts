import { loadConfig } from './app-config';

describe('restaurant-service configuration', () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://localhost/restaurant';
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.DEFAULT_DELIVERY_RADIUS_KM;
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('defaults the delivery radius to 5 km', () => {
    expect(loadConfig().defaultDeliveryRadiusKm).toBe(5);
  });

  it('loads a configured delivery radius', () => {
    process.env.DEFAULT_DELIVERY_RADIUS_KM = '7.5';

    expect(loadConfig().defaultDeliveryRadiusKm).toBe(7.5);
  });

  it.each(['0', '-1', '51', 'invalid'])('rejects invalid DEFAULT_DELIVERY_RADIUS_KM=%s', (value) => {
    process.env.DEFAULT_DELIVERY_RADIUS_KM = value;

    expect(() => loadConfig()).toThrow('DEFAULT_DELIVERY_RADIUS_KM');
  });
});
