/**
 * Delivery pricing (#145). Business rules, as decided by the owner:
 * - the customer pays the items plus a flat, configurable delivery fee;
 * - of the fee, the driver earns DRIVER_SHARE_PERCENT (50) and the platform keeps the rest;
 * - if a delivery is cancelled after pickup, the driver earns DRIVER_CANCEL_AFTER_PICKUP_PERCENT (25)
 *   of the fee instead, and the platform keeps the rest.
 * Everything is computed here, in whole piasters, at checkout and stored on the order as a snapshot,
 * so later configuration changes never alter an existing order.
 */
export interface PricingPolicy {
  /** Flat delivery fee in piasters (EGP × 100). */
  deliveryFeePiasters: number;
  driverSharePercent: number;
  driverCancelAfterPickupPercent: number;
}

export interface PricingSnapshot {
  subtotalAmount: string;
  deliveryFee: string;
  totalAmount: string;
  /** The driver's earning when the delivery is completed. */
  driverFeeShare: string;
  /** What the platform keeps when the delivery is completed. */
  platformFeeShare: string;
  /** The driver's earning when the delivery is cancelled after pickup. */
  driverCancelFeeShare: string;
}

export const DEFAULT_PRICING: PricingPolicy = { deliveryFeePiasters: 2500, driverSharePercent: 50, driverCancelAfterPickupPercent: 25 };

export function toPiasters(amount: number | string): number {
  const value = typeof amount === 'number' ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(value)) throw new Error(`Not an amount: ${amount}`);
  return Math.round(value * 100);
}

export const fromPiasters = (piasters: number): string => (piasters / 100).toFixed(2);

/** Percent of an amount in piasters, rounded down; the platform's side takes the remainder. */
const percentOf = (piasters: number, percent: number) => Math.floor((piasters * percent) / 100);

export function priceOrder(subtotal: number | string, policy: PricingPolicy): PricingSnapshot {
  const subtotalPiasters = toPiasters(subtotal);
  const fee = policy.deliveryFeePiasters;
  const driver = percentOf(fee, policy.driverSharePercent);
  return {
    subtotalAmount: fromPiasters(subtotalPiasters),
    deliveryFee: fromPiasters(fee),
    totalAmount: fromPiasters(subtotalPiasters + fee),
    driverFeeShare: fromPiasters(driver),
    platformFeeShare: fromPiasters(fee - driver),
    driverCancelFeeShare: fromPiasters(percentOf(fee, policy.driverCancelAfterPickupPercent)),
  };
}

/**
 * Reads the policy from the environment, validating it: DELIVERY_FEE (EGP, e.g. "25.00"),
 * DELIVERY_FEE_DRIVER_SHARE_PERCENT and DELIVERY_FEE_DRIVER_CANCEL_AFTER_PICKUP_PERCENT (0–100).
 * Unset values use the decided defaults (EGP 25, 50 %, 25 %); invalid values stop the service.
 */
export function pricingFromEnv(env: NodeJS.ProcessEnv): PricingPolicy {
  const fee = env.DELIVERY_FEE?.trim();
  if (fee !== undefined && fee !== '' && !/^\d+(\.\d{1,2})?$/.test(fee)) {
    throw new Error(`DELIVERY_FEE must be an amount in EGP with up to 2 decimals, got "${fee}"`);
  }
  const percent = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${name} must be a whole percent 0–100, got "${raw}"`);
    return value;
  };
  return {
    deliveryFeePiasters: fee ? toPiasters(fee) : DEFAULT_PRICING.deliveryFeePiasters,
    driverSharePercent: percent('DELIVERY_FEE_DRIVER_SHARE_PERCENT', DEFAULT_PRICING.driverSharePercent),
    driverCancelAfterPickupPercent: percent(
      'DELIVERY_FEE_DRIVER_CANCEL_AFTER_PICKUP_PERCENT',
      DEFAULT_PRICING.driverCancelAfterPickupPercent,
    ),
  };
}
