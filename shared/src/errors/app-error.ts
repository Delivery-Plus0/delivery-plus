/**
 * Base application error carrying an HTTP status code and stable error code,
 * so every service can produce a consistent error response shape:
 * { statusCode, error, message, timestamp, path }
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly error: string,
    message: string,
    /** Machine-readable specifics for clients, sent as `details` in the error response (e.g. #42's cart changes). */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(400, 'BadRequest', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'Unauthorized', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'Forbidden', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NotFound', message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'Conflict', message);
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(entity: string, from: string, to: string) {
    super(409, 'InvalidStateTransition', `Cannot transition ${entity} from ${from} to ${to}`);
  }
}

/** #42: the most of one menu item a cart (and so an order) may hold. */
export const MAX_CART_ITEM_QUANTITY = 20;

/** #42: what checkout found different between the cart and the menu, per item. */
export interface CartChange {
  menuItemId: string;
  name: string;
  /** PRICE_CHANGED: the cart now has the current price. UNAVAILABLE/REMOVED: taken out of the cart. QUANTITY_LIMITED: lowered to the maximum. */
  change: 'PRICE_CHANGED' | 'UNAVAILABLE' | 'REMOVED' | 'QUANTITY_LIMITED';
  previousPrice?: number;
  currentPrice?: number;
  previousQuantity?: number;
  currentQuantity?: number;
}

/**
 * #42: checkout found the cart out of date with the menu. The cart has already been brought up to
 * date (current prices, unavailable items removed), so the customer reviews it and places the order
 * again; nothing is ever charged at a price they didn't see.
 */
export class CartChangedError extends AppError {
  constructor(
    public readonly changes: CartChange[],
    message = 'Some items in your cart changed. Review your cart and place the order again.',
  ) {
    super(409, 'CartChanged', message, { changes });
  }
}

/**
 * #202: the account is suspended. Returned only after the password (or refresh token) checked out, so
 * it reveals nothing to someone who doesn't hold the account. Apps show a dedicated screen.
 */
export class AccountSuspendedError extends AppError {
  constructor(message = 'This account is suspended. Contact support.') {
    super(403, 'AccountSuspended', message);
  }
}

/** #153: the action needs a verified phone; clients answer it by showing the verification step. */
export class PhoneNotVerifiedError extends AppError {
  constructor(message = 'Verify your phone number to continue.') {
    super(403, 'PhoneNotVerified', message);
  }
}

/**
 * #206: only a driver an admin has VERIFIED can go online. `details.verificationStatus` (PENDING or
 * REJECTED) lets the driver app show "waiting for review" or "not approved".
 */
export class DriverNotVerifiedError extends AppError {
  constructor(verificationStatus: string) {
    super(
      403,
      'DriverNotVerified',
      verificationStatus === 'REJECTED'
        ? 'Your driver account was not approved, so you cannot go online.'
        : 'Your driver account is waiting for review. You can go online once it is approved.',
      { verificationStatus },
    );
  }
}

/**
 * #153: whether ordering and going online need a verified phone. Off unless PHONE_VERIFICATION_REQUIRED=true;
 * turn it on only together with a real SMS provider, or nobody could verify.
 */
export function phoneVerificationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PHONE_VERIFICATION_REQUIRED ?? '').trim().toLowerCase() === 'true';
}
