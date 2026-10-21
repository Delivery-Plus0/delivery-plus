import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { AccountSuspendedError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, generateCorrelationId } from '@food-delivery/shared';
import { CredentialsRepository } from '../repositories/credentials.repository';
import { UserServiceClient } from '../common/user-service.client';
import { RegisterDto, SELF_SERVICE_ROLES } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { VerifyEmailDto } from '../dto/verify-email.dto';
import { ResendVerificationDto } from '../dto/resend-verification.dto';
import { AuthResponseDto, VerificationRequiredResponseDto } from '../dto/auth-response.dto';
import { AppConfig, APP_CONFIG } from '../config/app-config';
import { UserRole } from '@food-delivery/shared';
import { AccountStatus, Credential } from '../entities/credential.entity';
import { StaffPermissionsRepository } from '../repositories/staff-permissions.repository';
import { InvalidRefreshTokenError, SessionContext, SessionsService } from './sessions.service';

const SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly credentials: CredentialsRepository,
    private readonly userServiceClient: UserServiceClient,
    private readonly jwtService: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionsService,
    private readonly staffPermissions: StaffPermissionsRepository,
  ) {}

  /**
   * Signs up and, unless email verification is required, signs in (#34). With
   * EMAIL_VERIFICATION_REQUIRED=true no tokens are issued until the email is verified and the user
   * logs in.
   */
  async register(
    dto: RegisterDto,
    correlationId = generateCorrelationId(),
    context: SessionContext = {},
  ): Promise<AuthResponseDto | VerificationRequiredResponseDto> {
    const role = this.resolveRegistrationRole(dto.role);
    const existing = await this.credentials.findByEmail(dto.email);
    if (existing) {
      throw new ConflictError(`Email ${dto.email} is already registered`);
    }

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS);
    const verificationToken = this.generateVerificationToken();

    const credential = await this.credentials.create({
      email: dto.email,
      passwordHash,
      role,
      emailVerified: false,
      failedLoginCount: 0,
      lockedUntil: null,
      lastFailedLoginAt: null,
      verificationTokenHash: this.hashToken(verificationToken),
      verificationTokenExpiresAt: this.addMinutes(new Date(), this.config.verificationTokenTtlMinutes),
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

    if (this.config.emailVerificationRequired && !credential.emailVerified) {
      throw new UnauthorizedError('Please verify your email before logging in');
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

  async verifyEmail(dto: VerifyEmailDto): Promise<{ message: string }> {
    const credential = await this.credentials.findByEmail(dto.email);
    if (!credential) {
      throw new UnauthorizedError('Invalid or expired verification token');
    }

    const isExpired = !credential.verificationTokenExpiresAt || credential.verificationTokenExpiresAt.getTime() <= Date.now();
    const isValid = credential.verificationTokenHash && this.hashToken(dto.token) === credential.verificationTokenHash && !isExpired;

    if (!isValid) {
      throw new UnauthorizedError('Invalid or expired verification token');
    }

    await this.credentials.update(credential.id, {
      emailVerified: true,
      verificationTokenHash: null,
      verificationTokenExpiresAt: null,
    });

    return { message: 'Email verified successfully' };
  }

  async resendVerification(dto: ResendVerificationDto): Promise<{ message: string }> {
    const credential = await this.credentials.findByEmail(dto.email);
    if (!credential || credential.emailVerified) {
      return { message: 'If that account exists, a verification email has been sent' };
    }

    const token = this.generateVerificationToken();
    await this.credentials.update(credential.id, {
      verificationTokenHash: this.hashToken(token),
      verificationTokenExpiresAt: this.addMinutes(new Date(), this.config.verificationTokenTtlMinutes),
    });

    return { message: 'If that account exists, a verification email has been sent' };
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

  private generateVerificationToken(): string {
    return randomBytes(32).toString('hex');
  }

  private hashToken(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private addMinutes(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60_000);
  }
}
