import { haversineKm } from './geo';

describe('haversineKm', () => {
  it('calculates the Cairo to Giza distance', () => {
    expect(haversineKm(30.0444, 31.2357, 29.9792, 31.1342)).toBeCloseTo(12.2, 1);
  });

  it('returns zero for the same point', () => {
    expect(haversineKm(30.0444, 31.2357, 30.0444, 31.2357)).toBe(0);
  });

  it('is symmetric', () => {
    expect(haversineKm(30.0444, 31.2357, 29.9792, 31.1342)).toBeCloseTo(
      haversineKm(29.9792, 31.1342, 30.0444, 31.2357),
      12,
    );
  });
});
