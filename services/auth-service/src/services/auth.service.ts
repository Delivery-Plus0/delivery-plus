import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { ConflictError, ForbiddenError, UnauthorizedError, generateCorrelationId } from '@food-delivery/shared';
import { CredentialsRepository } from '../repositories/credentials.repository';
import { UserServiceClient } from '../common/user-service.client';
import { RegisterDto, SELF_SERVICE_ROLES } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { VerifyEmailDto } from '../dto/verify-email.dto';
import { ResendVerificationDto } from '../dto/resend-verification.dto';
import { AuthResponseDto, VerificationRequiredResponseDto } from '../dto/auth-response.dto';
import { AppConfig, APP_CONFIG } from '../config/app-config';
import { UserRole } from '@food-delivery/shared';
import { Credential } from '../entities/credential.entity';
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

    await this.credentials.resetFailureState(credential.id);

    return this.signIn(credential, { ...context, appId: dto.appId ?? context.appId });
  }

  /**
   * Exchanges a refresh token for a new pair (#34). The token rotates; the role is read again from
   * the credential, so a changed role applies from the next access token.
   */
  async refresh(refreshToken: string): Promise<AuthResponseDto> {
    const { session, refreshToken: next } = await this.sessions.rotate(refreshToken);
    const credential = await this.credentials.findById(session.credentialId);
    if (!credential) {
      await this.sessions.end(session.id, 'admin');
      throw new InvalidRefreshTokenError();
    }
    return this.tokensFor(credential, session.id, next, session.expiresAt);
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

  /** The access token names its session (`sid`), so a password change can keep only this one (#35). */
  private async tokensFor(credential: Credential, sessionId: string, refreshToken: string, refreshExpiresAt: Date): Promise<AuthResponseDto> {
    const accessToken = await this.jwtService.signAsync({ sub: credential.id, email: credential.email, role: credential.role, sid: sessionId });
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
