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
import { AuthResponseDto } from '../dto/auth-response.dto';
import { AppConfig, APP_CONFIG } from '../config/app-config';
import { UserRole } from '@food-delivery/shared';

const SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly credentials: CredentialsRepository,
    private readonly userServiceClient: UserServiceClient,
    private readonly jwtService: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async register(dto: RegisterDto, correlationId = generateCorrelationId()): Promise<AuthResponseDto> {
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

    return this.issueToken(credential.id, credential.email, credential.role);
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
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

    return this.issueToken(credential.id, credential.email, credential.role);
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

  private async issueToken(userId: string, email: string, role: UserRole): Promise<AuthResponseDto> {
    const accessToken = await this.jwtService.signAsync({ sub: userId, email, role });
    return { accessToken, userId, email, role };
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
