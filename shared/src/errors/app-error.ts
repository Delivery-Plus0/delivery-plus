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

/** #153: the action needs a verified phone; clients answer it by showing the verification step. */
export class PhoneNotVerifiedError extends AppError {
  constructor(message = 'Verify your phone number to continue.') {
    super(403, 'PhoneNotVerified', message);
  }
}

/**
 * #153: whether ordering and going online need a verified phone. Off unless PHONE_VERIFICATION_REQUIRED=true;
 * turn it on only together with a real SMS provider, or nobody could verify.
 */
export function phoneVerificationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PHONE_VERIFICATION_REQUIRED ?? '').trim().toLowerCase() === 'true';
}
