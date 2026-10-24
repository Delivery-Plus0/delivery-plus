import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError, INTERNAL_AUTH_HEADERS, UnauthorizedError, signInternalRequest } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface CreateProfilePayload {
  userId: string;
  email: string;
  fullName: string;
  phone?: string;
}
/** user-service has no SMS provider configured (or it failed). The same answer for every phone. */
export class SmsUnavailableError extends AppError {
  constructor(message = 'Password reset by text message is not available right now. Please try again later.') {
    super(503, 'SmsUnavailable', message);
  }
}

/**
 * Synchronous internal HTTP call to user-service.
 *
 * SIMPLIFICATION: Until Kafka is introduced (Phase 9), auth-service and
 * user-service are kept consistent via a direct synchronous call instead of
 * an async `user.created` event + saga/compensation. If this call fails,
 * registration is rolled back (see AuthService.register). This will be
 * replaced by an idempotent event-driven flow in the Kafka phase.
 */
@Injectable()
export class UserServiceClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async createProfile(payload: CreateProfilePayload, correlationId: string): Promise<void> {
    const path = '/internal/users';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const body: Record<string, unknown> = {
      userId: payload.userId,
      authCredentialId: payload.userId,
      email: payload.email,
      fullName: payload.fullName,
    };
    if (payload.phone) {
      body.phone = payload.phone;
    }
    const signature = signInternalRequest({
      method: 'POST',
      path,
      timestamp,
      nonce,
      body,
      service: this.config.internalAuthService,
      secret: this.config.internalAuthSecret,
    });
    const response = await fetch(`${this.config.userServiceUrl}/internal/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-correlation-id': correlationId,
        [INTERNAL_AUTH_HEADERS.service]: this.config.internalAuthService,
        [INTERNAL_AUTH_HEADERS.timestamp]: timestamp,
        [INTERNAL_AUTH_HEADERS.nonce]: nonce,
        [INTERNAL_AUTH_HEADERS.signature]: signature,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new InternalServerErrorException(
        `Failed to create user profile (status ${response.status})`,
      );
    }
  }

    /** Signs and sends one internal call. The signed body is exactly the JSON that goes out (ADR 001). */
  private signedPost(path: string, body: Record<string, unknown>, correlationId: string): Promise<Response> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const signature = signInternalRequest({
      method: 'POST',
      path,
      timestamp,
      nonce,
      body,
      service: this.config.internalAuthService,
      secret: this.config.internalAuthSecret,
    });
    return fetch(`${this.config.userServiceUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-correlation-id': correlationId,
        [INTERNAL_AUTH_HEADERS.service]: this.config.internalAuthService,
        [INTERNAL_AUTH_HEADERS.timestamp]: timestamp,
        [INTERNAL_AUTH_HEADERS.nonce]: nonce,
        [INTERNAL_AUTH_HEADERS.signature]: signature,
      },
      body: JSON.stringify(body),
    });
  }

  /** Asks user-service to text a reset code. It answers the same whether or not the phone has an account. */
  async sendPasswordResetCode(phone: string, correlationId: string): Promise<void> {
    const response = await this.signedPost('/internal/users/password-reset/send', { phone }, correlationId);
    if (response.status === 503) throw new SmsUnavailableError();
    if (!response.ok) {
      throw new InternalServerErrorException(`Failed to request a password reset code (status ${response.status})`);
    }
  }

  /** Returns the owner's user id when the code is right; one generic 401 otherwise. */
  async verifyPasswordResetCode(phone: string, code: string, correlationId: string): Promise<{ userId: string }> {
    const response = await this.signedPost('/internal/users/password-reset/verify', { phone, code }, correlationId);
    if (response.status === 401) throw new UnauthorizedError('Invalid or expired code');
    if (!response.ok) {
      throw new InternalServerErrorException(`Failed to verify a password reset code (status ${response.status})`);
    }
    return (await response.json()) as { userId: string };
  }
}
