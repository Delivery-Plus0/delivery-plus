import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  AccountSuspendedError,
  AppError,
  BadRequestError,
  ConflictError,
  EmailNotVerifiedError,
  ForbiddenError,
  JwtPayload,
  NotFoundError,
  RateLimiterService,
  UnauthorizedError,
  generateCorrelationId,
} from '@food-delivery/shared';
import { EmailSender, EmailUnavailableError } from '../email/email-sender';
import { EmailLocale, buildVerificationEmail, hashVerificationCode, newVerificationCode, verificationCodeMatches } from '../email/verification-email';
import { CredentialsRepository } from '../repositories/credentials.repository';
import { UserServiceClient } from '../common/user-service.client';
import { RegisterDto, SELF_SERVICE_ROLES } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { VerifyEmailDto } from '../dto/verify-email.dto';
import { ResendVerificationDto } from '../dto/resend-verification.dto';
import { AuthResponseDto, VerificationRequiredResponseDto } from '../dto/auth-response.dto';
import { AppConfig, APP_CONFIG } from '../config/app-config';
import { UserRole } from '@food-delivery/shared';
import { AccountStatus, Credential } from '../entities/credential.entity';
import { StaffPermissionsRepository } from '../repositories/staff-permissions.repository';
import { InvalidRefreshTokenError, SessionContext, SessionsService } from './sessions.service';

const SALT_ROUNDS = 10;

/** #203: resend limits, counted whether or not the address has an account, so a 429 reveals nothing. */
const RESEND_PER_EMAIL_PER_HOUR = 5;
const RESEND_PER_IP_PER_HOUR = 20;
const GENERIC_RESEND_MESSAGE = 'If that account exists, a verification email has been sent';
const INVALID_CODE_MESSAGE = 'Invalid or expired verification code';

export interface VerificationRequestContext {
  correlationId: string;
  locale: EmailLocale;
  clientIp: string;
}
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly credentials: CredentialsRepository,
    private readonly userServiceClient: UserServiceClient,
    private readonly jwtService: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionsService,
    private readonly staffPermissions: StaffPermissionsRepository,
    private readonly emailSender: EmailSender,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  /**
   * Signs up and, unless email verification is required, signs in (#34). With
   * EMAIL_VERIFICATION_REQUIRED=true no tokens are issued until the email is verified and the user
   * logs in.
   */
  async register(
    dto: RegisterDto,
    correlationId = generateCorrelationId(),
    context: SessionContext & { locale?: EmailLocale } = {},
  ): Promise<AuthResponseDto | VerificationRequiredResponseDto> {
    const role = this.resolveRegistrationRole(dto.role);
    const existing = await this.credentials.findByEmail(dto.email);
    if (existing) {
      throw new ConflictError(`Email ${dto.email} is already registered`);
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);

    const credential = await this.credentials.create({
      email: dto.email,
      passwordHash,
      role,
      emailVerified: false,
      failedLoginCount: 0,
      lockedUntil: null,
      lastFailedLoginAt: null,
      // The code is created when it is emailed, just below (#203).
      verificationTokenHash: null,
      verificationTokenExpiresAt: null,
    });

    try {
      await this.userServiceClient.createProfile(
        {
          userId: credential.id,
          email: credential.email,
          fullName: dto.fullName,
          phone: dto.phone,
        },
        correlationId,
      );
    } catch (err) {
      await this.credentials.deleteById(credential.id);
      throw err;
    }

    // #203: email the code. Registration never fails because of email: the account exists, and the
    // user can ask for another code.
    if (this.emailSender.enabled) {
      try {
        await this.sendVerificationCode(credential, context.locale ?? 'ar', correlationId);
        await this.rateLimiter.incrementAndCheck(this.resendCooldownKey(credential.email), 1, this.config.verificationResendCooldownSeconds);
      } catch (error) {
        this.logger.warn(`Verification email not sent at registration (correlation ${correlationId}): ${error instanceof AppError ? error.error : 'error'}`);
      }
    }

    if (this.config.emailVerificationRequired) {
      return { userId: credential.id, verificationRequired: true };
    }
    return this.signIn(credential, { ...context, appId: dto.appId ?? context.appId });
  }

  async login(dto: LoginDto, context: SessionContext = {}): Promise<AuthResponseDto> {
    const credential = await this.credentials.findByEmail(dto.email);
    if (!credential) {
      throw new UnauthorizedError('Invalid email or password');
    }

    if (credential.lockedUntil && credential.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedError('Invalid email or password');
    }

    if (credential.lockedUntil && credential.lockedUntil.getTime() <= Date.now()) {
      await this.credentials.resetFailureState(credential.id);
    }

    const passwordMatches = await bcrypt.compare(dto.password, credential.passwordHash);
    if (!passwordMatches) {
      const updatedCredential = await this.credentials.recordFailedLogin(credential.id, new Date());
      const nextCount = updatedCredential?.failedLoginCount ?? 1;
      const shouldLock = nextCount >= this.config.maxFailedLoginAttempts;

      if (shouldLock) {
        await this.credentials.update(credential.id, {
          lockedUntil: this.addMinutes(new Date(), this.config.lockoutMinutes),
        });
      }

      throw new UnauthorizedError('Invalid email or password');
    }

    // #252: its own 403 code so the apps open the code screen; still only after the password checked out.
    if (this.config.emailVerificationRequired && !credential.emailVerified) {
      throw new EmailNotVerifiedError();
    }

    // #202: only after the password checked out, so the answer reveals nothing to a stranger.
    if (credential.status === 'SUSPENDED') {
      throw new AccountSuspendedError();
    }

    await this.credentials.resetFailureState(credential.id);

    return this.signIn(credential, { ...context, appId: dto.appId ?? context.appId });
  }

  /**
   * Exchanges a refresh token for a new pair (#34). The token rotates; the role is read again from
   * the credential, so a changed role applies from the next access token.
   */
  async refresh(refreshToken: string): Promise<AuthResponseDto> {
    let rotated: Awaited<ReturnType<SessionsService['rotate']>>;
    try {
      rotated = await this.sessions.rotate(refreshToken);
    } catch (error) {
      // A session ended by a suspension answers AccountSuspended while the account still is (#202),
      // so the app shows the suspended screen instead of a plain sign-in.
      if (error instanceof InvalidRefreshTokenError && error.endedSession?.revokedReason === 'suspended') {
        const owner = await this.credentials.findById(error.endedSession.credentialId);
        if (owner?.status === 'SUSPENDED') throw new AccountSuspendedError();
      }
      throw error;
    }
    const { session, refreshToken: next } = rotated;
    const credential = await this.credentials.findById(session.credentialId);
    if (!credential) {
      await this.sessions.end(session.id, 'admin');
      throw new InvalidRefreshTokenError();
    }
    if (credential.status === 'SUSPENDED') {
      await this.sessions.end(session.id, 'suspended');
      throw new AccountSuspendedError();
    }
    return this.tokensFor(credential, session.id, next, session.expiresAt);
  }

  /**
   * #202: suspend or reactivate an account (staff with `users.manage`). Suspending ends every refresh
   * session; access tokens already issued expire within JWT_EXPIRES_IN. Staff accounts are managed
   * with the staff tools (#216), so this refuses them, and nobody can suspend themselves.
   */
  async setAccountStatus(
    userId: string,
    status: AccountStatus,
    reason: string | null,
    actorId: string,
  ): Promise<{ userId: string; status: AccountStatus; suspendedAt: string | null; suspendedReason: string | null; sessionsRevoked: number }> {
    if (userId === actorId) throw new ForbiddenError('You cannot change the status of your own account');
    const credential = await this.credentials.findById(userId);
    if (!credential) throw new NotFoundError(`User ${userId} not found`);
    if (credential.role === UserRole.ADMIN) throw new ForbiddenError('Staff accounts are managed with the staff tools');

    const updated = (await this.credentials.setStatus(userId, status, status === 'SUSPENDED' ? reason : null)) as Credential;
    const sessionsRevoked = status === 'SUSPENDED' ? await this.sessions.revokeAll(userId, 'suspended') : 0;
    return {
      userId,
      status: updated.status,
      suspendedAt: updated.suspendedAt ? updated.suspendedAt.toISOString() : null,
      suspendedReason: updated.suspendedReason,
      sessionsRevoked,
    };
  }

  /** Ends the session of this refresh token. Always succeeds, so it reveals nothing about the token. */
  async logout(refreshToken: string): Promise<void> {
    await this.sessions.endByToken(refreshToken, 'logout');
  }

  /** Ends every session of the signed-in user, on every device. */
  async logoutAll(credentialId: string): Promise<void> {
    await this.sessions.revokeAll(credentialId, 'logout_all');
  }

  /**
   * #203: checks the 6-digit code from the email (sent in `token`). It works once, for
   * VERIFICATION_TOKEN_TTL_MINUTES; a wrong code counts, and the attempt that reaches
   * VERIFICATION_MAX_ATTEMPTS invalidates the code. Every failure is the same 401.
   */
  async verifyEmail(dto: VerifyEmailDto, now = new Date()): Promise<{ message: string }> {
    const credential = await this.credentials.findByEmail(dto.email);
    const code = dto.token.trim();
    if (!credential || !credential.verificationTokenHash || !credential.verificationTokenExpiresAt || credential.verificationTokenExpiresAt <= now) {
      // Same work as a real check, so the answer time doesn't tell whether the account exists.
      hashVerificationCode(code, credential?.id ?? 'none', this.config.emailCodeHashSecret);
      throw new UnauthorizedError(INVALID_CODE_MESSAGE);
    }

    if (!verificationCodeMatches(code, credential.id, this.config.emailCodeHashSecret, credential.verificationTokenHash)) {
      await this.credentials.recordWrongVerificationCode(credential.id, this.config.verificationMaxAttempts);
      throw new UnauthorizedError(INVALID_CODE_MESSAGE);
    }
    if (!(await this.credentials.consumeVerificationCode(credential.id, credential.verificationTokenHash, now))) {
      throw new UnauthorizedError(INVALID_CODE_MESSAGE);
    }
    return { message: 'Email verified successfully' };
  }

  /**
   * #203: emails a new code. The limits run first and count every address, known or not: one email per
   * VERIFICATION_RESEND_COOLDOWN_SECONDS and RESEND_PER_EMAIL_PER_HOUR per address, RESEND_PER_IP_PER_HOUR
   * per client IP. 503 when email isn't set up (for everyone) or the provider failed.
   */
  async resendVerification(dto: ResendVerificationDto, context: VerificationRequestContext): Promise<{ message: string }> {
    if (!this.emailSender.enabled) {
      throw new EmailUnavailableError('Email verification is not available yet. Please try again later.');
    }
    const emailKey = this.emailKey(dto.email);
    const allowed =
      (await this.rateLimiter.incrementAndCheck(`ratelimit:verification-resend:ip:${context.clientIp}`, RESEND_PER_IP_PER_HOUR, 3600)) &&
      (await this.rateLimiter.incrementAndCheck(`ratelimit:verification-resend:email-hour:${emailKey}`, RESEND_PER_EMAIL_PER_HOUR, 3600)) &&
      (await this.rateLimiter.incrementAndCheck(this.resendCooldownKey(dto.email), 1, this.config.verificationResendCooldownSeconds));
    if (!allowed) {
      throw new AppError(429, 'TooManyRequests', 'Please wait a minute before asking for another code.');
    }

    const credential = await this.credentials.findByEmail(dto.email);
    if (!credential || credential.emailVerified) {
      return { message: GENERIC_RESEND_MESSAGE };
    }
    await this.sendVerificationCode(credential, context.locale, context.correlationId);
    return { message: GENERIC_RESEND_MESSAGE };
  }

  /** Stores a new code (HMAC, attempts reset) and emails it. The code itself is never logged or returned. */
  private async sendVerificationCode(credential: Credential, locale: EmailLocale, correlationId: string): Promise<void> {
    const now = new Date();
    const code = newVerificationCode();
    await this.credentials.setVerificationCode(
      credential.id,
      hashVerificationCode(code, credential.id, this.config.emailCodeHashSecret),
      this.addMinutes(now, this.config.verificationTokenTtlMinutes),
      now,
    );
    await this.emailSender.send(buildVerificationEmail(credential.email, code, locale, this.config.verificationTokenTtlMinutes), { correlationId });
  }

  private emailKey(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  }

  private resendCooldownKey(email: string): string {
    return `ratelimit:verification-resend:cooldown:${this.emailKey(email)}`;
  }

  /**
   * The role is server-authoritative: the DTO already rejects privileged roles, and this repeats the
   * check so the invariant holds for any caller of register(), not only requests through the pipe.
   */
  private resolveRegistrationRole(requested: UserRole | null | undefined): UserRole {
    // @IsOptional() lets null through, and it has always meant "use the default", like omitting it.
    if (requested === undefined || requested === null) return UserRole.CUSTOMER;
    if (!SELF_SERVICE_ROLES.includes(requested)) {
      throw new ForbiddenError(`Role ${String(requested)} cannot be self-assigned at registration`);
    }
    return requested;
  }

  private async signIn(credential: Credential, context: SessionContext): Promise<AuthResponseDto> {
    const { session, refreshToken } = await this.sessions.start(credential.id, context);
    return this.tokensFor(credential, session.id, refreshToken, session.expiresAt);
  }

  /**
   * The access token names its session (`sid`), so a password change can keep only this one (#35).
   * Staff tokens also carry their permissions (`perms`, #202), read fresh at every login and refresh.
   */
  private async tokensFor(credential: Credential, sessionId: string, refreshToken: string, refreshExpiresAt: Date): Promise<AuthResponseDto> {
    const perms = credential.role === UserRole.ADMIN ? await this.staffPermissions.listFor(credential.id) : undefined;
    const accessToken = await this.jwtService.signAsync({
      sub: credential.id,
      email: credential.email,
      role: credential.role,
      sid: sessionId,
      ...(perms ? { perms } : {}),
    });
    const { exp } = this.jwtService.decode(accessToken) as { exp: number };
    return {
      accessToken,
      accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      userId: credential.id,
      email: credential.email,
      role: credential.role,
    };
  }


  private addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
  }

    /**
   * Changes the password of the signed-in user. Every other session ends; the one this access
   * token belongs to (`sid`) stays signed in. Access tokens already issued last up to 15 minutes.
   */
  async changePassword(user: JwtPayload, dto: ChangePasswordDto): Promise<void> {
    const credential = await this.credentials.findById(user.sub);
    if (!credential) {
      throw new UnauthorizedError('Invalid credentials');
    }
    
    const matches = await bcrypt.compare(dto.currentPassword, credential.passwordHash);
    if (!matches) {
      throw new UnauthorizedError('Current password is incorrect');
    }

     if (credential.status === 'SUSPENDED') {
      throw new AccountSuspendedError();
    }

     if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestError('New password must differ from the current one');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, SALT_ROUNDS);
    await this.credentials.update(credential.id, { passwordHash });
    await this.sessions.revokeAll(credential.id, 'password_changed', user.sid);
  }
}
