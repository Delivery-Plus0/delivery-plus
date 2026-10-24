import { AuthService } from './auth.service';
import { CredentialsRepository } from '../repositories/credentials.repository';
import { UserServiceClient, SmsUnavailableError } from '../common/user-service.client';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { UserRole, ConflictError, ForbiddenError, UnauthorizedError, RateLimitGuard, RATE_LIMIT_KEY, JwtPayload, JwtAuthGuard, AccountSuspendedError } from '@food-delivery/shared';
import { SELF_SERVICE_ROLES } from '../dto/register.dto';
import * as bcrypt from 'bcrypt';
import { loadConfig, loadTestAdmin } from '../config/app-config';
import { AuthController } from '../controllers/auth.controller';
import { SessionsService } from './sessions.service';
import { StaffPermissionsRepository } from '../repositories/staff-permissions.repository';
import { EmailSender, EmailUnavailableError } from '../email/email-sender';
import { hashVerificationCode } from '../email/verification-email';
import { RateLimiterService } from '@food-delivery/shared';

describe('AuthService', () => {
  const manager = {} as never;
  let service: AuthService;
  let credentials: jest.Mocked<CredentialsRepository>;
  let userServiceClient: jest.Mocked<UserServiceClient>;
  let jwtService: jest.Mocked<JwtService>;
  let sessions: jest.Mocked<SessionsService>;
  let staffPermissions: jest.Mocked<StaffPermissionsRepository>;
  let emailSender: jest.Mocked<EmailSender>;
  let rateLimiter: jest.Mocked<RateLimiterService>;

  beforeEach(() => {
    credentials = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      recordFailedLogin: jest.fn(),
      resetFailureState: jest.fn(),
      transaction: jest.fn(async (work: (m: unknown) => Promise<unknown>) => work(manager)),   
      deleteById: jest.fn(),
      setVerificationCode: jest.fn(),
      consumeVerificationCode: jest.fn(),
      recordWrongVerificationCode: jest.fn(),
    } as unknown as jest.Mocked<CredentialsRepository>;

    userServiceClient = {
  createProfile: jest.fn(),
  sendPasswordResetCode: jest.fn(),
  verifyPasswordResetCode: jest.fn(),
  } as unknown as jest.Mocked<UserServiceClient>;

    jwtService = {
      signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
      decode: jest.fn().mockReturnValue({ exp: 1_800_000_000 }),
    } as unknown as jest.Mocked<JwtService>;

    sessions = {
      start: jest.fn().mockResolvedValue({ session: { id: 'session-1', expiresAt: new Date('2026-11-19T00:00:00Z') }, refreshToken: 'session-1.refresh-secret' }),
      rotate: jest.fn(),
      endByToken: jest.fn(),
      revokeAll: jest.fn(),
      end: jest.fn(),
    } as unknown as jest.Mocked<SessionsService>;

    staffPermissions = { listFor: jest.fn().mockResolvedValue(['users.manage']) } as unknown as jest.Mocked<StaffPermissionsRepository>;
    emailSender = { enabled: true, send: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<EmailSender>;
    rateLimiter = { incrementAndCheck: jest.fn().mockResolvedValue(true) } as unknown as jest.Mocked<RateLimiterService>;

    service = new AuthService(credentials, userServiceClient, jwtService, {
      serviceName: 'auth-service',
      port: 3001,
      nodeEnv: 'test',
      databaseUrl: 'postgres://postgres:postgres@localhost:5432/auth_service',
      jwtSecret: 'secret',
      jwtExpiresIn: '1h',
      userServiceUrl: 'http://localhost:3002',
      internalAuthService: 'auth-service',
      internalAuthSecret: 'dev-secret',
      emailVerificationRequired: false,
      maxFailedLoginAttempts: 5,
      lockoutMinutes: 15,
      verificationTokenTtlMinutes: 10,
      refreshTokenTtlDays: 30,
      sessionCleanupIntervalMs: 0,
      sessionRetentionDays: 30,
      internalAuthAllowedServices: [],
      testAdmin: null,
      verificationMaxAttempts: 5,
      verificationResendCooldownSeconds: 60,
      emailProvider: 'test',
      emailCodeHashSecret: 'local-email-code-development-only',
      ses: null,
    }, sessions, staffPermissions, emailSender, rateLimiter);
  });

  describe('config validation', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      }
      for (const [key, value] of Object.entries(originalEnv)) {
        process.env[key] = value;
      }
    });

    it('accepts valid positive integer configuration values', () => {
      process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/auth_service';
      process.env.JWT_SECRET = 'secret';
      process.env.MAX_FAILED_LOGIN_ATTEMPTS = '7';
      process.env.LOCKOUT_MINUTES = '30';

      const config = loadConfig();

      expect(config.maxFailedLoginAttempts).toBe(7);
      expect(config.lockoutMinutes).toBe(30);
    });

    it.each([
      ['unset', undefined, 5],
      ['empty', '', 5],
      ['zero', '0', 0],
      ['negative', '-1', -1],
      ['decimal', '1.5', 1.5],
      ['non-numeric', 'abc', NaN],
    ])('rejects invalid MAX_FAILED_LOGIN_ATTEMPTS values for %s', (_label, rawValue, expected) => {
      process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/auth_service';
      process.env.JWT_SECRET = 'secret';
      if (rawValue === undefined) {
        delete process.env.MAX_FAILED_LOGIN_ATTEMPTS;
      } else {
        process.env.MAX_FAILED_LOGIN_ATTEMPTS = rawValue;
      }
      process.env.LOCKOUT_MINUTES = '15';

      if (_label === 'unset' || _label === 'empty') {
        expect(loadConfig().maxFailedLoginAttempts).toBe(5);
        return;
      }

      expect(() => loadConfig()).toThrow(`Invalid MAX_FAILED_LOGIN_ATTEMPTS: ${rawValue}`);
      expect(expected).toBeDefined();
    });

    it.each([
      ['unset', undefined, 15],
      ['empty', '', 15],
      ['zero', '0', 0],
      ['negative', '-1', -1],
      ['decimal', '1.5', 1.5],
      ['non-numeric', 'abc', NaN],
    ])('rejects invalid LOCKOUT_MINUTES values for %s', (_label, rawValue, expected) => {
      process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/auth_service';
      process.env.JWT_SECRET = 'secret';
      process.env.MAX_FAILED_LOGIN_ATTEMPTS = '5';
      if (rawValue === undefined) {
        delete process.env.LOCKOUT_MINUTES;
      } else {
        process.env.LOCKOUT_MINUTES = rawValue;
      }

      if (_label === 'unset' || _label === 'empty') {
        expect(loadConfig().lockoutMinutes).toBe(15);
        return;
      }

      expect(() => loadConfig()).toThrow(`Invalid LOCKOUT_MINUTES: ${rawValue}`);
      expect(expected).toBeDefined();
    });

    it('defaults to 15-minute access tokens, 30-day sliding sessions and an hourly cleanup (#34)', () => {
      process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/auth_service';
      process.env.JWT_SECRET = 'secret';
      for (const key of ['JWT_EXPIRES_IN', 'REFRESH_TOKEN_TTL_DAYS', 'SESSION_CLEANUP_INTERVAL_MS', 'SESSION_RETENTION_DAYS', 'AUTH_INTERNAL_ALLOWED_SERVICES']) {
        delete process.env[key];
      }

      expect(loadConfig()).toMatchObject({
        jwtExpiresIn: '15m',
        refreshTokenTtlDays: 30,
        sessionCleanupIntervalMs: 3_600_000,
        sessionRetentionDays: 30,
        internalAuthAllowedServices: [],
      });
    });

    it('creates a test admin only from both TEST_ADMIN_* values, and never in production (#202)', () => {
      expect(loadTestAdmin('test', {})).toBeNull();
      expect(loadTestAdmin('test', { TEST_ADMIN_EMAIL: ' qa.admin@x.test ', TEST_ADMIN_PASSWORD: 'p'.repeat(12) })).toEqual({ email: 'qa.admin@x.test', password: 'p'.repeat(12) });
      expect(() => loadTestAdmin('test', { TEST_ADMIN_EMAIL: 'qa.admin@x.test' })).toThrow('Set both');
      expect(() => loadTestAdmin('production', { TEST_ADMIN_EMAIL: 'a@x.test', TEST_ADMIN_PASSWORD: 'p'.repeat(12) })).toThrow('bootstrap CLI');
      expect(loadTestAdmin('production', {})).toBeNull();
    });

    it('reads the session settings and the internal callers list', () => {
      process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/auth_service';
      process.env.JWT_SECRET = 'secret';
      process.env.SESSION_CLEANUP_INTERVAL_MS = '0';
      process.env.AUTH_INTERNAL_ALLOWED_SERVICES = ' user-service, admin-api ,';

      expect(loadConfig()).toMatchObject({ sessionCleanupIntervalMs: 0, internalAuthAllowedServices: ['user-service', 'admin-api'] });

      process.env.REFRESH_TOKEN_TTL_DAYS = '0';
      expect(() => loadConfig()).toThrow('Invalid REFRESH_TOKEN_TTL_DAYS: 0');
      delete process.env.REFRESH_TOKEN_TTL_DAYS;
      process.env.SESSION_CLEANUP_INTERVAL_MS = '-1';
      expect(() => loadConfig()).toThrow('Invalid SESSION_CLEANUP_INTERVAL_MS: -1');
    });
  });

  describe('route rate limiting', () => {
    it('applies the shared rate limiter to verification routes', () => {
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, AuthController.prototype.verifyEmail)).toEqual({
        limit: 5,
        windowSeconds: 60,
      });
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, AuthController.prototype.resendVerification)).toEqual({
        limit: 5,
        windowSeconds: 60,
      });
      expect(Reflect.getMetadata('__guards__', AuthController.prototype.verifyEmail)).toEqual(
        expect.arrayContaining([RateLimitGuard]),
      );
      expect(Reflect.getMetadata('__guards__', AuthController.prototype.resendVerification)).toEqual(
        expect.arrayContaining([RateLimitGuard]),
      );
    });
  });

  describe('register', () => {
    it('throws ConflictError when email already exists', async () => {
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'a@a.com',
        passwordHash: 'x',
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(
        service.register({ email: 'a@a.com', password: 'password123', fullName: 'A' }),
      ).rejects.toThrow(ConflictError);
    });

    it('creates credential, calls user-service, and returns a token', async () => {
      credentials.findByEmail.mockResolvedValue(null);
      credentials.create.mockResolvedValue({
        id: 'new-user-id',
        email: 'b@b.com',
        passwordHash: 'hashed',
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        verificationTokenHash: 'token-hash',
        verificationTokenExpiresAt: new Date(Date.now() + 60000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      userServiceClient.createProfile.mockResolvedValue(undefined);

      const result: any = await service.register({
        email: 'b@b.com',
        password: 'password123',
        fullName: 'B',
      });

      expect(userServiceClient.createProfile).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'new-user-id', email: 'b@b.com', fullName: 'B' }),
        expect.any(String),
      );
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.userId).toBe('new-user-id');
    });

    it('rolls back the credential if user-service call fails', async () => {
      credentials.findByEmail.mockResolvedValue(null);
      credentials.create.mockResolvedValue({
        id: 'orphan-id',
        email: 'c@c.com',
        passwordHash: 'hashed',
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        verificationTokenHash: 'token-hash',
        verificationTokenExpiresAt: new Date(Date.now() + 60000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      userServiceClient.createProfile.mockRejectedValue(new Error('user-service down'));

      await expect(
        service.register({ email: 'c@c.com', password: 'password123', fullName: 'C' }),
      ).rejects.toThrow('user-service down');

      expect(credentials.deleteById).toHaveBeenCalledWith('orphan-id');
    });

    describe('role is server-authoritative (no self-assigned privileges)', () => {
      // The repository returns what the service asked it to persist, so the token's role can only
      // come from the role the service decided on.
      beforeEach(() => {
        credentials.findByEmail.mockResolvedValue(null);
        credentials.create.mockImplementation(async (data) =>
          ({ id: 'new-user-id', ...data, createdAt: new Date(), updatedAt: new Date() }) as any,
        );
        userServiceClient.createProfile.mockResolvedValue(undefined);
      });

      // Every role outside the self-service allow-list: ADMIN today, and any privileged role added later.
      const privilegedRoles = Object.values(UserRole).filter((role) => !SELF_SERVICE_ROLES.includes(role));

      it('keeps ADMIN out of the self-service roles', () => {
        expect(privilegedRoles).toContain(UserRole.ADMIN);
        expect(SELF_SERVICE_ROLES).not.toContain(UserRole.ADMIN);
      });

      it.each(privilegedRoles)('refuses to register a %s account and persists nothing', async (role) => {
        await expect(
          service.register({ email: 'attacker@example.com', password: 'valid-password', fullName: 'Attacker', role }),
        ).rejects.toThrow(ForbiddenError);

        expect(credentials.findByEmail).not.toHaveBeenCalled();
        expect(credentials.create).not.toHaveBeenCalled();
        expect(userServiceClient.createProfile).not.toHaveBeenCalled();
        expect(jwtService.signAsync).not.toHaveBeenCalled();
      });

      it('registers a normal user as CUSTOMER with a hashed password and a CUSTOMER token', async () => {
        const result: any = await service.register({ email: 'jane@example.com', password: 'valid-password', fullName: 'Jane' });

        const persisted = credentials.create.mock.calls[0][0];
        expect(persisted.role).toBe(UserRole.CUSTOMER);
        expect(persisted.passwordHash).not.toBe('valid-password');
        await expect(bcrypt.compare('valid-password', persisted.passwordHash)).resolves.toBe(true);
        expect(userServiceClient.createProfile).toHaveBeenCalled();
        expect(jwtService.signAsync).toHaveBeenCalledWith({
          sub: 'new-user-id',
          email: 'jane@example.com',
          role: UserRole.CUSTOMER,
          sid: 'session-1',
        });
        expect(result.role).toBe(UserRole.CUSTOMER);
      });

      it('treats an explicit null role like an omitted one (CUSTOMER)', async () => {
        const result: any = await service.register({
          email: 'nullrole@example.com',
          password: 'valid-password',
          fullName: 'Null Role',
          role: null as unknown as UserRole,
        });

        expect(credentials.create.mock.calls[0][0].role).toBe(UserRole.CUSTOMER);
        expect(result.role).toBe(UserRole.CUSTOMER);
      });

      it.each(SELF_SERVICE_ROLES)('still lets a caller register as %s', async (role) => {
        const result: any = await service.register({ email: 'b@b.com', password: 'valid-password', fullName: 'B', role });

        expect(credentials.create.mock.calls[0][0].role).toBe(role);
        expect(jwtService.signAsync).toHaveBeenCalledWith(expect.objectContaining({ role }));
        expect(result.role).toBe(role);
      });
    });
  });

  describe('login', () => {
    it('throws UnauthorizedError for unknown email', async () => {
      credentials.findByEmail.mockResolvedValue(null);
      await expect(service.login({ email: 'nope@a.com', password: 'whatever' })).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it.each([true, false])(
      'throws the generic authentication error for wrong passwords on %s accounts',
      async (emailVerified) => {
        const hash = await bcrypt.hash('correct-password', 10);
        credentials.findByEmail.mockResolvedValue({
          id: 'u1',
          email: 'd@d.com',
          passwordHash: hash,
          role: UserRole.CUSTOMER,
          emailVerified,
          failedLoginCount: 0,
          lockedUntil: null,
          verificationTokenHash: null,
          verificationTokenExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);
        credentials.recordFailedLogin.mockResolvedValue({
          id: 'u1',
          email: 'd@d.com',
          passwordHash: hash,
          role: UserRole.CUSTOMER,
          emailVerified,
          failedLoginCount: 1,
          lockedUntil: null,
          lastFailedLoginAt: new Date(),
          verificationTokenHash: null,
          verificationTokenExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);

        await expect(service.login({ email: 'd@d.com', password: 'wrong-password' })).rejects.toThrow(
          'Invalid email or password',
        );
        expect(credentials.recordFailedLogin).toHaveBeenCalledWith('u1', expect.any(Date));
      },
    );

    it('returns a token for verified credentials and resets failure state', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'e@e.com',
        passwordHash: hash,
        role: UserRole.ADMIN,
        emailVerified: true,
        failedLoginCount: 3,
        lockedUntil: null,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.update.mockResolvedValue({} as any);

      const result = await service.login({ email: 'e@e.com', password: 'correct-password' });
      expect(credentials.resetFailureState).toHaveBeenCalledWith('u1');
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.role).toBe(UserRole.ADMIN);
    });

    it('locks the account after the configured failed-attempt threshold', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'locked@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 4,
        lockedUntil: null,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.recordFailedLogin.mockResolvedValue({
        id: 'u1',
        email: 'locked@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 5,
        lockedUntil: null,
        lastFailedLoginAt: new Date(),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.login({ email: 'locked@example.com', password: 'wrong-password' })).rejects.toThrow(
        'Invalid email or password',
      );

      expect(credentials.recordFailedLogin).toHaveBeenCalledWith('u1', expect.any(Date));
      expect(credentials.update).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({
          lockedUntil: expect.any(Date),
        }),
      );
    });

    it('rejects login while the account is still locked', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'locked@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() + 60_000),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(
        service.login({ email: 'locked@example.com', password: 'correct-password' }),
      ).rejects.toThrow('Invalid email or password');
    });

    it('starts a new failure sequence from 1 after an expired lockout', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'expired@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() - 1000),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.recordFailedLogin.mockResolvedValue({
        id: 'u1',
        email: 'expired@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 1,
        lockedUntil: null,
        lastFailedLoginAt: new Date(),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.login({ email: 'expired@example.com', password: 'wrong-password' })).rejects.toThrow(
        'Invalid email or password',
      );

      expect(credentials.resetFailureState).toHaveBeenCalledWith('u1');
      expect(credentials.recordFailedLogin).toHaveBeenCalledWith('u1', expect.any(Date));
    });

    it('clears the failure state and lock when valid credentials are used after an expired lock', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'expired@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() - 1000),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.update.mockResolvedValue({} as any);

      await service.login({ email: 'expired@example.com', password: 'correct-password' });

      expect(credentials.resetFailureState).toHaveBeenCalledWith('u1');
    });

    it('requires email verification before a successful login when enabled', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      service = new AuthService(credentials, userServiceClient, jwtService, {
        ...service['config'],
        emailVerificationRequired: true,
      }, sessions, staffPermissions, emailSender, rateLimiter);

      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'verify@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.login({ email: 'verify@example.com', password: 'correct-password' })).rejects.toMatchObject({
        statusCode: 403,
        error: 'EmailNotVerified',
        message: 'Please verify your email before logging in',
      });
    });

    it('answers a wrong password on an unverified account with the usual 401, not EmailNotVerified (#252)', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      service = new AuthService(credentials, userServiceClient, jwtService, {
        ...service['config'],
        emailVerificationRequired: true,
      }, sessions, staffPermissions, emailSender, rateLimiter);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'verify@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.update.mockResolvedValue({} as any);

      const refused = service.login({ email: 'verify@example.com', password: 'wrong-password' });

      await expect(refused).rejects.toBeInstanceOf(UnauthorizedError);
      await expect(refused).rejects.toMatchObject({ statusCode: 401, message: 'Invalid email or password' });
    });

    it('signs in an unverified account normally while verification is not required (#252)', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'verify@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: false,
        status: 'ACTIVE',
        failedLoginCount: 0,
        lockedUntil: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.update.mockResolvedValue({} as any);

      await expect(service.login({ email: 'verify@example.com', password: 'correct-password' })).resolves.toHaveProperty('accessToken');
    });
  });

  describe('sessions (#34)', () => {
    const credential = (overrides: Record<string, unknown> = {}) =>
      ({
        id: 'u1',
        email: 's@example.com',
        role: UserRole.DRIVER,
        emailVerified: true,
        failedLoginCount: 0,
        lockedUntil: null,
        ...overrides,
      }) as any;

    it('login starts a session for the app and returns both tokens with their expiries', async () => {
      credentials.findByEmail.mockResolvedValue(credential({ passwordHash: await bcrypt.hash('pw-12345678', 4) }));

      const result = await service.login({ email: 's@example.com', password: 'pw-12345678', appId: 'driver' }, { userAgent: 'UA' });

      expect(sessions.start).toHaveBeenCalledWith('u1', { userAgent: 'UA', appId: 'driver' });
      expect(jwtService.signAsync).toHaveBeenCalledWith({ sub: 'u1', email: 's@example.com', role: UserRole.DRIVER, sid: 'session-1' });
      expect(result).toEqual({
        accessToken: 'signed.jwt.token',
        accessTokenExpiresAt: new Date(1_800_000_000 * 1000).toISOString(),
        refreshToken: 'session-1.refresh-secret',
        refreshTokenExpiresAt: '2026-11-19T00:00:00.000Z',
        userId: 'u1',
        email: 's@example.com',
        role: UserRole.DRIVER,
      });
    });

    it('register returns no tokens while email verification is required, and starts no session', async () => {
      service = new AuthService(credentials, userServiceClient, jwtService, { ...service['config'], emailVerificationRequired: true }, sessions, staffPermissions, emailSender, rateLimiter);
      credentials.findByEmail.mockResolvedValue(null);
      credentials.create.mockResolvedValue(credential({ id: 'new-user', emailVerified: false }));
      userServiceClient.createProfile.mockResolvedValue(undefined);

      const result = await service.register({ email: 'n@example.com', password: 'valid-password', fullName: 'N' });

      expect(result).toEqual({ userId: 'new-user', verificationRequired: true });
      expect(sessions.start).not.toHaveBeenCalled();
      expect(jwtService.signAsync).not.toHaveBeenCalled();
    });

    it('register signs in (both tokens) when email verification is off', async () => {
      credentials.findByEmail.mockResolvedValue(null);
      credentials.create.mockResolvedValue(credential({ id: 'new-user' }));
      userServiceClient.createProfile.mockResolvedValue(undefined);

      const result: any = await service.register({ email: 'n@example.com', password: 'valid-password', fullName: 'N', appId: 'customer' });

      expect(sessions.start).toHaveBeenCalledWith('new-user', { appId: 'customer' });
      expect(result).toMatchObject({ accessToken: 'signed.jwt.token', refreshToken: 'session-1.refresh-secret' });
    });

    it('refresh returns the rotated token and re-reads the role from the credential', async () => {
      sessions.rotate.mockResolvedValue({ session: { id: 'session-1', credentialId: 'u1', expiresAt: new Date('2026-12-01T00:00:00Z') } as any, refreshToken: 'session-1.next' });
      credentials.findById.mockResolvedValue(credential({ role: UserRole.CUSTOMER }));

      const result = await service.refresh('session-1.old');

      expect(sessions.rotate).toHaveBeenCalledWith('session-1.old');
      expect(jwtService.signAsync).toHaveBeenCalledWith(expect.objectContaining({ role: UserRole.CUSTOMER, sid: 'session-1' }));
      expect(result).toMatchObject({ refreshToken: 'session-1.next', refreshTokenExpiresAt: '2026-12-01T00:00:00.000Z', role: UserRole.CUSTOMER });
    });

    it('refresh ends the session when its credential is gone', async () => {
      sessions.rotate.mockResolvedValue({ session: { id: 'session-1', credentialId: 'gone', expiresAt: new Date() } as any, refreshToken: 'x' });
      credentials.findById.mockResolvedValue(null);

      await expect(service.refresh('session-1.old')).rejects.toMatchObject({ statusCode: 401, error: 'InvalidRefreshToken' });
      expect(sessions.end).toHaveBeenCalledWith('session-1', 'admin');
    });

    it('logout ends the session of the token; logout-all ends every session of the user', async () => {
      await service.logout('session-1.secret');
      await service.logoutAll('u1');

      expect(sessions.endByToken).toHaveBeenCalledWith('session-1.secret', 'logout');
      expect(sessions.revokeAll).toHaveBeenCalledWith('u1', 'logout_all');
    });
  });

  describe('email verification by code (#203)', () => {
    const SECRET = 'test-email-code-secret';
    const unverified = (overrides: Record<string, unknown> = {}) =>
      ({
        id: 'u1',
        email: 'verify@example.com',
        role: UserRole.CUSTOMER,
        emailVerified: false,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        ...overrides,
      }) as any;
    const withCode = (code: string, expiresInMs = 60_000) =>
      unverified({ verificationTokenHash: hashVerificationCode(code, 'u1', SECRET), verificationTokenExpiresAt: new Date(Date.now() + expiresInMs) });
    const context = { correlationId: 'corr-1', locale: 'en' as const, clientIp: '203.0.113.7' };

    beforeEach(() => {
      service['config'].emailCodeHashSecret = SECRET;
    });

    it('register emails a 6-digit code and stores only its HMAC', async () => {
      credentials.findByEmail.mockResolvedValue(null);
      credentials.create.mockResolvedValue(unverified());
      userServiceClient.createProfile.mockResolvedValue(undefined);

      const result = await service.register({ email: 'verify@example.com', password: 'valid-password', fullName: 'V' }, 'corr-1', { locale: 'en' });

      expect(emailSender.send).toHaveBeenCalledTimes(1);
      const [message, sendContext] = emailSender.send.mock.calls[0];
      const code = message.text.match(/\b\d{6}\b/)?.[0] as string;
      expect(code).toMatch(/^\d{6}$/);
      expect(message).toMatchObject({ to: 'verify@example.com', subject: 'Your Delivery Plus verification code' });
      expect(message.html).toContain(code);
      expect(sendContext).toEqual({ correlationId: 'corr-1' });
      const [id, storedHash, expiresAt] = credentials.setVerificationCode.mock.calls[0];
      expect(id).toBe('u1');
      expect(storedHash).toBe(hashVerificationCode(code, 'u1', SECRET));
      expect(storedHash).not.toContain(code);
      expect((expiresAt as Date).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
      expect(JSON.stringify(result)).not.toContain(code);
    });

    it('register still succeeds when the email fails or email is disabled', async () => {
      credentials.findByEmail.mockResolvedValue(null);
      credentials.create.mockResolvedValue(unverified());
      userServiceClient.createProfile.mockResolvedValue(undefined);
      emailSender.send.mockRejectedValueOnce(new EmailUnavailableError());

      await expect(service.register({ email: 'verify@example.com', password: 'valid-password', fullName: 'V' })).resolves.toMatchObject({ userId: 'u1' });

      Object.assign(emailSender, { enabled: false });
      emailSender.send.mockClear();
      await expect(service.register({ email: 'verify@example.com', password: 'valid-password', fullName: 'V' })).resolves.toMatchObject({ userId: 'u1' });
      expect(emailSender.send).not.toHaveBeenCalled();
    });

    it('verifies with the right code, once (compare-and-set on the stored hash)', async () => {
      credentials.findByEmail.mockResolvedValue(withCode('123456'));
      credentials.consumeVerificationCode.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(service.verifyEmail({ email: 'verify@example.com', token: '123456' })).resolves.toEqual({ message: 'Email verified successfully' });
      expect(credentials.consumeVerificationCode).toHaveBeenCalledWith('u1', hashVerificationCode('123456', 'u1', SECRET), expect.any(Date));
      // A second request racing the first loses the compare-and-set.
      await expect(service.verifyEmail({ email: 'verify@example.com', token: '123456' })).rejects.toThrow('Invalid or expired verification code');
    });

    it.each([['a wrong code', '654321'], ['a malformed code', '12ab56'], ['the hex token of the old scheme', 'a'.repeat(64)]])(
      'counts %s as a wrong attempt (the 5th invalidates the code)',
      async (_label, token) => {
        credentials.findByEmail.mockResolvedValue(withCode('123456'));

        await expect(service.verifyEmail({ email: 'verify@example.com', token })).rejects.toThrow('Invalid or expired verification code');
        expect(credentials.recordWrongVerificationCode).toHaveBeenCalledWith('u1', 5);
        expect(credentials.consumeVerificationCode).not.toHaveBeenCalled();
      },
    );

    it('refuses an expired code, a used one and an unknown email the same way, without counting', async () => {
      credentials.findByEmail.mockResolvedValueOnce(withCode('123456', -1)).mockResolvedValueOnce(unverified()).mockResolvedValueOnce(null);

      for (let i = 0; i < 3; i++) {
        await expect(service.verifyEmail({ email: 'verify@example.com', token: '123456' })).rejects.toThrow('Invalid or expired verification code');
      }
      expect(credentials.recordWrongVerificationCode).not.toHaveBeenCalled();
    });

    it('resend emails a fresh code to an unverified account', async () => {
      credentials.findByEmail.mockResolvedValue(unverified());

      await expect(service.resendVerification({ email: 'verify@example.com' }, context)).resolves.toEqual({
        message: 'If that account exists, a verification email has been sent',
      });
      expect(credentials.setVerificationCode).toHaveBeenCalled();
      expect(emailSender.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'verify@example.com' }), { correlationId: 'corr-1' });
    });

    it('resend answers the same for unknown and already-verified addresses, sending nothing', async () => {
      credentials.findByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce(unverified({ emailVerified: true }));

      for (const email of ['nobody@example.com', 'verify@example.com']) {
        await expect(service.resendVerification({ email }, context)).resolves.toEqual({ message: 'If that account exists, a verification email has been sent' });
      }
      expect(emailSender.send).not.toHaveBeenCalled();
    });

    it('applies the cooldown and the per-email and per-IP limits before looking the account up', async () => {
      rateLimiter.incrementAndCheck.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await expect(service.resendVerification({ email: 'Nobody@Example.com' }, context)).rejects.toMatchObject({ statusCode: 429 });
      expect(credentials.findByEmail).not.toHaveBeenCalled();
      const keys = rateLimiter.incrementAndCheck.mock.calls.map(([key, limit, windowSeconds]) => [key.replace(/[0-9a-f]{64}/, '<email>'), limit, windowSeconds]);
      expect(keys).toEqual([
        ['ratelimit:verification-resend:ip:203.0.113.7', 20, 3600],
        ['ratelimit:verification-resend:email-hour:<email>', 5, 3600],
        ['ratelimit:verification-resend:cooldown:<email>', 1, 60],
      ]);
      // The address is never part of a key in clear.
      expect(JSON.stringify(rateLimiter.incrementAndCheck.mock.calls)).not.toMatch(/nobody@example\.com/i);
    });

    it('resend answers 503 EmailUnavailable for everyone while email is disabled', async () => {
      Object.assign(emailSender, { enabled: false });

      await expect(service.resendVerification({ email: 'verify@example.com' }, context)).rejects.toMatchObject({ statusCode: 503, error: 'EmailUnavailable' });
      expect(credentials.findByEmail).not.toHaveBeenCalled();
    });
  });

    describe('changePassword', () => {
    const user = { sub: 'u1', email: 'cp@example.com', role: UserRole.CUSTOMER, sid: 'session-1' } as JwtPayload;
    const dto = { currentPassword: 'old-password-1', newPassword: 'new-password-2' };

    const storedCredential = async () =>
      ({
        id: 'u1',
        email: 'cp@example.com',
        passwordHash: await bcrypt.hash('old-password-1', 4),
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 0,
        lockedUntil: null,
      }) as any;

    it('hashes and saves the new password, then revokes the other sessions', async () => {
      credentials.findById.mockResolvedValue(await storedCredential());

      await service.changePassword(user, dto);

      const [id, changes] = credentials.update.mock.calls[0];
      expect(id).toBe('u1');
      expect(changes.passwordHash).not.toBe('new-password-2');
      await expect(bcrypt.compare('new-password-2', changes.passwordHash as string)).resolves.toBe(true);
      expect(sessions.revokeAll).toHaveBeenCalledWith('u1', 'password_changed', 'session-1', manager);
    });

    it('rejects a wrong current password and changes nothing', async () => {
      credentials.findById.mockResolvedValue(await storedCredential());

      await expect(
        service.changePassword(user, { ...dto, currentPassword: 'not-the-password' }),
      ).rejects.toThrow('Current password is incorrect');

      expect(credentials.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });

    it('rejects when the credential no longer exists', async () => {
      credentials.findById.mockResolvedValue(null);

      await expect(service.changePassword(user, dto)).rejects.toThrow(UnauthorizedError);

      expect(credentials.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });

    it('does not revoke sessions if saving the new password fails', async () => {
      credentials.findById.mockResolvedValue(await storedCredential());
      credentials.update.mockRejectedValue(new Error('db down'));

      await expect(service.changePassword(user, dto)).rejects.toThrow('db down');

      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });

        it('keeps the current session: the session id is passed as the one to spare, and nothing ends it', async () => {
      credentials.findById.mockResolvedValue(await storedCredential());

      await service.changePassword(user, dto);

      expect(sessions.revokeAll).toHaveBeenCalledTimes(1);
      expect(sessions.revokeAll.mock.calls[0][2]).toBe('session-1');
      expect(sessions.end).not.toHaveBeenCalled();
      expect(sessions.endByToken).not.toHaveBeenCalled();
    });

    it('never logs either password', async () => {
      const spies = [
        jest.spyOn(console, 'log'),
        jest.spyOn(console, 'warn'),
        jest.spyOn(console, 'error'),
        jest.spyOn(Logger.prototype, 'log'),
        jest.spyOn(Logger.prototype, 'warn'),
        jest.spyOn(Logger.prototype, 'error'),
      ];
      credentials.findById.mockResolvedValue(await storedCredential());

      await service.changePassword(user, dto);
      await service.changePassword(user, { ...dto, currentPassword: 'not-the-password' }).catch(() => undefined);

      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      for (const secret of ['old-password-1', 'new-password-2', 'not-the-password']) {
        expect(logged).not.toContain(secret);
      }
      spies.forEach((s) => s.mockRestore());
    });
      it('refuses a suspended account with AccountSuspended and changes nothing', async () => {
      credentials.findById.mockResolvedValue({ ...(await storedCredential()), status: 'SUSPENDED' });

      await expect(service.changePassword(user, dto)).rejects.toThrow(AccountSuspendedError);

      expect(credentials.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });

    it('rejects a new password equal to the current one and changes nothing', async () => {
      credentials.findById.mockResolvedValue(await storedCredential());

      await expect(
        service.changePassword(user, { currentPassword: 'old-password-1', newPassword: 'old-password-1' }),
      ).rejects.toThrow('New password must differ from the current one');

      expect(credentials.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });

    it('answers a wrong current password with 401 even for a suspended account', async () => {
      credentials.findById.mockResolvedValue({ ...(await storedCredential()), status: 'SUSPENDED' });

      await expect(
        service.changePassword(user, { ...dto, currentPassword: 'not-the-password' }),
      ).rejects.toThrow(UnauthorizedError);
    });
  });
   describe('changePassword lockout and atomicity (#35)', () => {
    const user = { sub: 'u1', sid: 'session-1' } as JwtPayload;
    const dto = { currentPassword: 'current-password', newPassword: 'brand-new-password' } as ChangePasswordDto;
    const wrong = { ...dto, currentPassword: 'not-the-password' } as ChangePasswordDto;
    let hash: string;

    beforeAll(async () => {
      hash = await bcrypt.hash(dto.currentPassword, 4);
    });

    const credential = (overrides: Record<string, unknown> = {}) =>
      ({ id: 'u1', passwordHash: hash, status: 'ACTIVE', lockedUntil: null, failedLoginCount: 0, ...overrides }) as never;

    it('counts a wrong current password as a failed attempt and changes nothing', async () => {
      credentials.findById.mockResolvedValue(credential());
      credentials.recordFailedLogin.mockResolvedValue({ failedLoginCount: 1 } as never);

      await expect(service.changePassword(user, wrong)).rejects.toThrow('Current password is incorrect');

      expect(credentials.recordFailedLogin).toHaveBeenCalledWith('u1', expect.any(Date));
      expect(credentials.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });

    it('locks the account when the failed attempts reach the threshold', async () => {
      credentials.findById.mockResolvedValue(credential());
      credentials.recordFailedLogin.mockResolvedValue({ failedLoginCount: 99 } as never);

      await expect(service.changePassword(user, wrong)).rejects.toThrow('Current password is incorrect');

      expect(credentials.update).toHaveBeenCalledWith('u1', { lockedUntil: expect.any(Date) });
    });

    it('answers a locked account like a wrong password, even with the right one, and counts nothing', async () => {
      credentials.findById.mockResolvedValue(credential({ lockedUntil: new Date(Date.now() + 60_000) }));

      await expect(service.changePassword(user, dto)).rejects.toThrow('Current password is incorrect');

      expect(credentials.recordFailedLogin).not.toHaveBeenCalled();
      expect(credentials.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });

    it('starts a new failure sequence after an expired lockout', async () => {
      credentials.findById.mockResolvedValue(credential({ lockedUntil: new Date(Date.now() - 1000), failedLoginCount: 5 }));
      credentials.recordFailedLogin.mockResolvedValue({ failedLoginCount: 1 } as never);

      await expect(service.changePassword(user, wrong)).rejects.toThrow('Current password is incorrect');

      expect(credentials.resetFailureState).toHaveBeenCalledWith('u1');
      expect(credentials.resetFailureState.mock.invocationCallOrder[0]).toBeLessThan(
        credentials.recordFailedLogin.mock.invocationCallOrder[0],
      );
      expect(credentials.update).not.toHaveBeenCalled();
    });

    it('clears the failure state with the new hash, in the same transaction as the revoke', async () => {
      credentials.findById.mockResolvedValue(credential({ failedLoginCount: 3 }));

      await service.changePassword(user, dto);

      expect(credentials.transaction).toHaveBeenCalledTimes(1);
      expect(credentials.update).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ failedLoginCount: 0, lockedUntil: null, lastFailedLoginAt: null }),
        manager,
      );
      expect(sessions.revokeAll).toHaveBeenCalledWith('u1', 'password_changed', 'session-1', manager);
    });

    it('fails the whole change when ending the sessions fails', async () => {
      credentials.findById.mockResolvedValue(credential());
      sessions.revokeAll.mockRejectedValue(new Error('revoke down'));

      await expect(service.changePassword(user, dto)).rejects.toThrow('revoke down');

      expect(credentials.transaction).toHaveBeenCalledTimes(1);
    });

    it('reset: fails the whole reset when ending the sessions fails', async () => {
      userServiceClient.verifyPasswordResetCode.mockResolvedValue({ userId: 'u1' });
      credentials.findById.mockResolvedValue(credential());
      sessions.revokeAll.mockRejectedValue(new Error('revoke down'));

      await expect(
        service.resetPassword({ phone: '+201012345678', code: '123456', newPassword: 'brand-new-password' } as never, 'c-1'),
      ).rejects.toThrow('revoke down');

      expect(credentials.transaction).toHaveBeenCalledTimes(1);
    });
  });

    describe('forgotPassword / resetPassword (#35)', () => {
    const phone = '+201012345678';
    const context = { correlationId: 'c-1', clientIp: '1.2.3.4' };
    const resetDto = { phone, code: '123456', newPassword: 'new-password-2' };
    const stored = (overrides = {}) => ({ id: 'u1', status: 'ACTIVE', passwordHash: 'old', ...overrides }) as any;

    beforeEach(() => {
      rateLimiter.incrementAndCheck.mockResolvedValue(true);
    });

    it('forgot: limits per IP and per phone first, then asks user-service, and always answers the same', async () => {
      userServiceClient.sendPasswordResetCode.mockResolvedValue(undefined);
      const result = await service.forgotPassword({ phone }, context);

      expect(result).toEqual({ message: 'If that account exists, a code has been sent' });
      expect(rateLimiter.incrementAndCheck).toHaveBeenCalledTimes(2);
      expect(userServiceClient.sendPasswordResetCode).toHaveBeenCalledWith(phone, 'c-1');
      const keys = rateLimiter.incrementAndCheck.mock.calls.map((call) => call[0]).join(' ');
      expect(keys).not.toContain('1012345678');
    });

    it('forgot: a limit answers 429 and sends nothing', async () => {
      rateLimiter.incrementAndCheck.mockResolvedValue(false);
      await expect(service.forgotPassword({ phone }, context)).rejects.toMatchObject({ statusCode: 429 });
      expect(userServiceClient.sendPasswordResetCode).not.toHaveBeenCalled();
    });

    it('forgot: passes on user-service 503 SmsUnavailable', async () => {
      userServiceClient.sendPasswordResetCode.mockRejectedValue(new SmsUnavailableError());
      await expect(service.forgotPassword({ phone }, context)).rejects.toBeInstanceOf(SmsUnavailableError);
    });

    it('reset: sets the hash, clears the lockout and revokes every session', async () => {
      userServiceClient.verifyPasswordResetCode.mockResolvedValue({ userId: 'u1' });
      credentials.findById.mockResolvedValue(stored());

      await service.resetPassword(resetDto, 'c-1');

      const [id, changes] = credentials.update.mock.calls[0];
      expect(id).toBe('u1');
      expect(changes).toMatchObject({ failedLoginCount: 0, lockedUntil: null, lastFailedLoginAt: null });
      await expect(bcrypt.compare('new-password-2', changes.passwordHash as string)).resolves.toBe(true);
      expect(sessions.revokeAll).toHaveBeenCalledWith('u1', 'password_reset', undefined, manager);
    });

    it('reset: a bad code changes nothing', async () => {
      userServiceClient.verifyPasswordResetCode.mockRejectedValue(new UnauthorizedError('Invalid or expired code'));
      await expect(service.resetPassword(resetDto, 'c-1')).rejects.toBeInstanceOf(UnauthorizedError);
      expect(credentials.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });

    it('reset: refuses a suspended account with 403 and changes nothing', async () => {
      userServiceClient.verifyPasswordResetCode.mockResolvedValue({ userId: 'u1' });
      credentials.findById.mockResolvedValue(stored({ status: 'SUSPENDED' }));
      await expect(service.resetPassword(resetDto, 'c-1')).rejects.toBeInstanceOf(AccountSuspendedError);
      expect(credentials.update).not.toHaveBeenCalled();
      expect(sessions.revokeAll).not.toHaveBeenCalled();
    });

    it('reset: an unknown credential is the same generic 401', async () => {
      userServiceClient.verifyPasswordResetCode.mockResolvedValue({ userId: 'gone' });
      credentials.findById.mockResolvedValue(null);
      await expect(service.resetPassword(resetDto, 'c-1')).rejects.toThrow('Invalid or expired code');
    });
  });
  

  describe('ChangePasswordDto', () => {
  const check = (newPassword: string) =>
    validate(plainToInstance(ChangePasswordDto, { currentPassword: 'x', newPassword }));

  it('rejects a new password under 8 characters', async () => {
    expect((await check('Short1')).length).toBeGreaterThan(0);
  });

  it('accepts an 8 character password', async () => {
    expect(await check('Abcdefg1')).toHaveLength(0);
  });
});

describe('POST /auth/password/change', () => {
  it('requires a signed-in user', () => {
    const guards = Reflect.getMetadata('__guards__', AuthController.prototype.changePassword) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
  });
});
});
