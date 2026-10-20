import { UserRole } from '@food-delivery/shared';

/** Login, register (when email verification is off) and refresh (#34). */
export class AuthResponseDto {
  /** Short-lived JWT for `Authorization: Bearer` (JWT_EXPIRES_IN, 15 minutes by default). */
  accessToken!: string;
  accessTokenExpiresAt!: string;
  /** Opaque, single use: send it to POST /auth/refresh for a new pair. */
  refreshToken!: string;
  refreshTokenExpiresAt!: string;
  userId!: string;
  email!: string;
  role!: UserRole;
}

/** Register while EMAIL_VERIFICATION_REQUIRED=true: no tokens until the email is verified (#34, #203). */
export class VerificationRequiredResponseDto {
  userId!: string;
  verificationRequired!: true;
}
