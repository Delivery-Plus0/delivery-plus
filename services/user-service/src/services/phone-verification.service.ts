import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, randomUUID } from 'crypto';
import { AppError, BadRequestError, ConflictError, JwtPayload, safeEqual } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { PhoneVerificationsRepository } from '../repositories/phone-verifications.repository';
import { SmsSender, SmsUnavailableError } from '../sms/sms-sender';
import { UserProfile } from '../entities/user-profile.entity';
import { UsersService } from './users.service';

/** The rules for one-time phone codes (#153). */
export const PHONE_OTP_POLICY = {
  codeLength: 6,
  ttlSeconds: 10 * 60,
  maxAttempts: 5,
  resendCooldownSeconds: 60,
  /** Per user and, separately, per number, so one account can't flood a number and many accounts can't either. */
  maxSendsPerHour: 5,
} as const;

export class TooManyRequestsError extends AppError {
  constructor(message: string) {
    super(429, 'TooManyRequests', message);
  }
}

export type PhoneVerificationStarted = {
  /** The number the code went to (E.164). */
  phone: string;
  expiresAt: string;
  resendAvailableAt: string;
};

@Injectable()
export class PhoneVerificationService {
  private readonly logger = new Logger(PhoneVerificationService.name);

  constructor(
    private readonly users: UsersService,
    private readonly verifications: PhoneVerificationsRepository,
    private readonly sms: SmsSender,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Sends a code to `phone` (a phone change) or, without it, to the profile's current number. The
   * phone only becomes the profile's verified number once the code is confirmed.
   */
  async start(requester: JwtPayload, phone?: string, now = new Date()): Promise<PhoneVerificationStarted> {
    const profile = await this.users.getOwnProfile(requester);
    const target = phone ?? profile.phone ?? null;
    if (!target) throw new BadRequestError('Add a phone number first.');
    if (target === profile.phone && profile.phoneVerifiedAt) throw new ConflictError('This phone number is already verified.');
    // Never pretend a code went out: without a provider, verification can't start.
    if (!this.sms.enabled) throw new SmsUnavailableError();

    const code = randomInt(0, 10 ** PHONE_OTP_POLICY.codeLength).toString().padStart(PHONE_OTP_POLICY.codeLength, '0');
    const id = randomUUID();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const row = await this.verifications.createUnderLimits(profile.id, target, hourAgo, (history) => {
      const cooldownEnds = history.latestSentAt ? history.latestSentAt.getTime() + PHONE_OTP_POLICY.resendCooldownSeconds * 1000 : 0;
      if (cooldownEnds > now.getTime()) {
        const wait = Math.ceil((cooldownEnds - now.getTime()) / 1000);
        throw new TooManyRequestsError(`Please wait ${wait} seconds before requesting another code.`);
      }
      if (history.sentByUser >= PHONE_OTP_POLICY.maxSendsPerHour || history.sentToPhone >= PHONE_OTP_POLICY.maxSendsPerHour) {
        throw new TooManyRequestsError('Too many codes requested. Please try again in an hour.');
      }
      return {
        id,
        userId: profile.id,
        phone: target,
        codeHash: this.hash(id, code),
        expiresAt: new Date(now.getTime() + PHONE_OTP_POLICY.ttlSeconds * 1000),
      };
    });

    try {
      await this.sms.send(target, `Your Delivery Plus code is ${code}. It expires in ${PHONE_OTP_POLICY.ttlSeconds / 60} minutes.`);
    } catch (error) {
      await this.verifications.delete(row.id);
      // The number and the code stay out of the logs.
      this.logger.warn(`phone.verification.send_failed user=${profile.id} error=${(error as Error).message}`);
      throw new SmsUnavailableError("We couldn't send the code. Please try again shortly.");
    }
    this.logger.log(`phone.verification.sent user=${profile.id}`);
    return {
      phone: target,
      expiresAt: row.expiresAt.toISOString(),
      resendAvailableAt: new Date(row.createdAt.getTime() + PHONE_OTP_POLICY.resendCooldownSeconds * 1000).toISOString(),
    };
  }

  /** Checks the code against the latest one sent; on success the number is the profile's verified phone. */
  async verify(requester: JwtPayload, code: string, now = new Date()): Promise<UserProfile> {
    const profile = await this.users.getOwnProfile(requester);
    const latest = await this.verifications.latestForUser(profile.id);
    if (!latest || latest.consumedAt) throw new BadRequestError('Request a new code first.');
    if (latest.expiresAt.getTime() <= now.getTime()) throw new BadRequestError('This code has expired. Request a new one.');

    const attempts = await this.verifications.registerAttempt(latest.id, PHONE_OTP_POLICY.maxAttempts);
    if (attempts === null) throw new TooManyRequestsError('Too many wrong codes. Request a new one.');
    if (!safeEqual(this.hash(latest.id, code), latest.codeHash)) {
      const left = PHONE_OTP_POLICY.maxAttempts - attempts;
      throw new BadRequestError(left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong codes. Request a new one.');
    }
    if (!(await this.verifications.consumeAndVerify(latest.id, profile.id, latest.phone))) {
      throw new BadRequestError('Request a new code first.');
    }
    this.logger.log(`phone.verification.verified user=${profile.id}`);
    return this.users.getOwnProfile(requester);
  }

  /** Keyed with a server secret and bound to the row, so a leaked table doesn't give the codes away. */
  private hash(id: string, code: string): string {
    return createHmac('sha256', this.config.otpHashSecret).update(`${id}:${code}`).digest('hex');
  }
}
