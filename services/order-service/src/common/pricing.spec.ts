import { DEFAULT_PRICING, priceOrder, pricingFromEnv } from './pricing';

describe('priceOrder', () => {
  it("applies the owner's example: EGP 200 + EGP 25 fee, split 12.50 / 12.50", () => {
    expect(priceOrder('200.00', DEFAULT_PRICING)).toEqual({
      subtotalAmount: '200.00',
      deliveryFee: '25.00',
      totalAmount: '225.00',
      driverFeeShare: '12.50',
      platformFeeShare: '12.50',
      driverCancelFeeShare: '6.25',
    });
  });

  it('never loses a piaster: odd splits round the driver down and the platform takes the rest', () => {
    const snapshot = priceOrder(10, { deliveryFeePiasters: 2501, driverSharePercent: 50, driverCancelAfterPickupPercent: 25 });
    expect(snapshot).toMatchObject({ deliveryFee: '25.01', driverFeeShare: '12.50', platformFeeShare: '12.51', driverCancelFeeShare: '6.25' });
  });

  it('adds money in piasters, so decimals stay exact', () => {
    expect(priceOrder(0.1 + 0.2, DEFAULT_PRICING).totalAmount).toBe('25.30');
    expect(priceOrder('19.98', DEFAULT_PRICING).totalAmount).toBe('44.98');
  });

  it('supports a free delivery', () => {
    expect(priceOrder('50', { ...DEFAULT_PRICING, deliveryFeePiasters: 0 })).toMatchObject({
      deliveryFee: '0.00',
      totalAmount: '50.00',
      driverFeeShare: '0.00',
      platformFeeShare: '0.00',
    });
  });
});

describe('pricingFromEnv', () => {
  it('defaults to the decided policy', () => {
    expect(pricingFromEnv({})).toEqual(DEFAULT_PRICING);
  });

  it('reads a configured fee and shares', () => {
    expect(
      pricingFromEnv({ DELIVERY_FEE: '30.50', DELIVERY_FEE_DRIVER_SHARE_PERCENT: '60', DELIVERY_FEE_DRIVER_CANCEL_AFTER_PICKUP_PERCENT: '30' }),
    ).toEqual({ deliveryFeePiasters: 3050, driverSharePercent: 60, driverCancelAfterPickupPercent: 30 });
  });

  it('refuses invalid configuration instead of guessing', () => {
    expect(() => pricingFromEnv({ DELIVERY_FEE: '25,00' })).toThrow('DELIVERY_FEE');
    expect(() => pricingFromEnv({ DELIVERY_FEE: '-5' })).toThrow('DELIVERY_FEE');
    expect(() => pricingFromEnv({ DELIVERY_FEE_DRIVER_SHARE_PERCENT: '101' })).toThrow('0–100');
    expect(() => pricingFromEnv({ DELIVERY_FEE_DRIVER_SHARE_PERCENT: '12.5' })).toThrow('whole percent');
  });
});
