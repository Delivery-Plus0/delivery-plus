import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { AllExceptionsFilter, INTERNAL_AUTH_HEADERS, RateLimiterService, UserRole, signInternalRequest } from '@food-delivery/shared';
import { AuthController } from './auth.controller';
import { InternalSessionsController } from './internal-sessions.controller';
import { AuthService } from '../services/auth.service';
import { SessionsService } from '../services/sessions.service';
import { SessionsRepository } from '../repositories/sessions.repository';
import { CredentialsRepository } from '../repositories/credentials.repository';
import { UserServiceClient } from '../common/user-service.client';
import { InternalAuthGuard } from '../guards/internal-auth.guard';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { InMemorySessions } from '../testing/in-memory-sessions';
import { Credential } from '../entities/credential.entity';

const JWT_SECRET = 'test-jwt-secret';
const INTERNAL_SECRET = 'test-internal-secret';
const PASSWORD = 'correct-password';

const config = {
  emailVerificationRequired: false,
  maxFailedLoginAttempts: 5,
  lockoutMinutes: 15,
  verificationTokenTtlMinutes: 60,
  refreshTokenTtlDays: 30,
  sessionCleanupIntervalMs: 0,
  sessionRetentionDays: 30,
  internalAuthSecret: INTERNAL_SECRET,
  internalAuthAllowedServices: ['user-service'],
} as AppConfig;

const sessionRows = new InMemorySessions();
const credentialRows = new Map<string, Credential>();
const credentials = {
  findByEmail: async (email: string) => [...credentialRows.values()].find((c) => c.email === email) ?? null,
  findById: async (id: string) => credentialRows.get(id) ?? null,
  resetFailureState: async () => undefined,
  recordFailedLogin: async (id: string) => credentialRows.get(id) ?? null,
  update: async () => null,
};
/** Counts per key like the Redis limiter, so the per-session refresh limit can be exercised. */
const counts = new Map<string, number>();
const limiter = {
  incrementAndCheck: async (key: string, limit: number) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return (counts.get(key) as number) <= limit;
  },
};
const nonces = new Set<string>();
const redis = { set: async (key: string) => (nonces.has(key) ? null : (nonces.add(key), 'OK')) };

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '15m' } })],
  controllers: [AuthController, InternalSessionsController],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: 'REDIS_CLIENT', useValue: redis },
    { provide: RateLimiterService, useValue: limiter },
    { provide: SessionsService, useFactory: () => new SessionsService(sessionRows as unknown as SessionsRepository, config) },
    {
      provide: AuthService,
      inject: [JwtService, SessionsService],
      useFactory: (jwt: JwtService, sessions: SessionsService) =>
        new AuthService(credentials as unknown as CredentialsRepository, {} as UserServiceClient, jwt, config, sessions),
    },
    InternalAuthGuard,
  ],
})
class AuthHttpTestModule {}

describe('Auth sessions over HTTP (#34)', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;
  let userId: string;

  beforeAll(async () => {
    userId = randomUUID();
    credentialRows.set(userId, {
      id: userId,
      email: 'driver@example.com',
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      role: UserRole.DRIVER,
      emailVerified: true,
      lockedUntil: null,
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      verificationTokenHash: null,
      verificationTokenExpiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    app = await NestFactory.create(AuthHttpTestModule, { logger: false, abortOnError: false });
    // The same pipe and filter as main.ts.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter({ log: jest.fn() } as never));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => counts.clear());

  const post = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const login = async (appId?: string) => (await post('/auth/login', { email: 'driver@example.com', password: PASSWORD, ...(appId ? { appId } : {}) })).body;
  const refresh = (refreshToken: string) => post('/auth/refresh', { refreshToken });

  it('login returns an access token, a refresh token and both expiries', async () => {
    const response = await post('/auth/login', { email: 'driver@example.com', password: PASSWORD, appId: 'driver' }, { 'User-Agent': 'DriverApp/1.0' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.stringMatching(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
      accessTokenExpiresAt: expect.any(String),
      refreshTokenExpiresAt: expect.any(String),
      userId,
      role: UserRole.DRIVER,
    });
    const minutes = (Date.parse(response.body.accessTokenExpiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    expect(sessionRows.rows.get(response.body.refreshToken.split('.')[0])).toMatchObject({ appId: 'driver', userAgent: 'DriverApp/1.0' });
  });

  it('rejects an unknown appId', async () => {
    expect((await post('/auth/login', { email: 'driver@example.com', password: PASSWORD, appId: 'tv' })).status).toBe(400);
  });

  it('keeps existing routes working with the access token, which now names its session', async () => {
    const { accessToken, refreshToken } = await login();

    const response = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sub: userId, role: UserRole.DRIVER, sid: refreshToken.split('.')[0] });
  });

  it('refresh rotates: a new pair comes back and the old refresh token fails', async () => {
    const first = await login();

    const rotated = await refresh(first.refreshToken);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.body.accessToken).toEqual(expect.any(String));

    const again = await refresh(first.refreshToken);
    expect(again.status).toBe(401);
    expect(again.body).toMatchObject({ error: 'InvalidRefreshToken' });
  });

  it('reusing a rotated token revokes the family: the newest token fails too', async () => {
    const first = await login();
    const second = (await refresh(first.refreshToken)).body;

    await refresh(first.refreshToken);

    expect((await refresh(second.refreshToken)).status).toBe(401);
  });

  it('refresh re-reads the role from the credential', async () => {
    const first = await login();
    credentialRows.get(userId)!.role = UserRole.CUSTOMER;
    try {
      const rotated = await refresh(first.refreshToken);
      expect(rotated.body.role).toBe(UserRole.CUSTOMER);
      expect(app.get(JwtService).decode(rotated.body.accessToken)).toMatchObject({ role: UserRole.CUSTOMER });
    } finally {
      credentialRows.get(userId)!.role = UserRole.DRIVER;
    }
  });

  it('logout ends the session (204) and the refresh token stops working; any token gets 204', async () => {
    const { refreshToken } = await login();

    expect((await post('/auth/logout', { refreshToken })).status).toBe(204);
    expect((await refresh(refreshToken)).status).toBe(401);
    expect((await post('/auth/logout', { refreshToken: 'whatever' })).status).toBe(204);
  });

  it('logout-all needs the access token and ends every session of the user', async () => {
    const a = await login('driver');
    const b = await login('customer');

    expect((await post('/auth/logout-all')).status).toBe(401);
    expect((await post('/auth/logout-all', undefined, { Authorization: `Bearer ${a.accessToken}` })).status).toBe(204);

    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect((await refresh(b.refreshToken)).status).toBe(401);
  });

  it('limits refreshes per session, not per IP (every client shares the gateway IP)', async () => {
    let token = (await login()).refreshToken;
    for (let i = 0; i < 10; i++) {
      const response = await refresh(token);
      expect(response.status).toBe(200);
      token = response.body.refreshToken;
    }
    expect((await refresh(token)).status).toBe(429);

    // Another session from the same IP is not affected.
    expect((await refresh((await login()).refreshToken)).status).toBe(200);
  });

  describe('POST /internal/auth/users/:id/revoke-sessions', () => {
    const path = () => `/internal/auth/users/${userId}/revoke-sessions`;
    const signed = (body: unknown, service = 'user-service', nonce: string = randomUUID()) => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      return {
        [INTERNAL_AUTH_HEADERS.service]: service,
        [INTERNAL_AUTH_HEADERS.timestamp]: timestamp,
        [INTERNAL_AUTH_HEADERS.nonce]: nonce,
        [INTERNAL_AUTH_HEADERS.signature]: signInternalRequest({ method: 'POST', path: path(), timestamp, nonce, body, service, secret: INTERNAL_SECRET }),
      };
    };

    it('revokes every session except the one named, for an allowed service', async () => {
      const keep = await login();
      const other = await login();
      const body = { reason: 'password_changed', exceptSessionId: keep.refreshToken.split('.')[0] };

      const response = await post(path(), body, signed(body));

      expect(response.status).toBe(200);
      expect(response.body.revoked).toBeGreaterThanOrEqual(1);
      expect((await refresh(other.refreshToken)).status).toBe(401);
      expect((await refresh(keep.refreshToken)).status).toBe(200);
    });

    it('refuses unsigned, wrongly signed, replayed and not-allowed callers', async () => {
      const body = { reason: 'suspended' };
      expect((await post(path(), body)).status).toBe(401);

      const tampered = signed(body);
      expect((await post(path(), { reason: 'admin' }, tampered)).status).toBe(401);

      const once = signed(body);
      expect((await post(path(), body, once)).status).toBe(200);
      expect((await post(path(), body, once)).status).toBe(401);

      expect((await post(path(), body, signed(body, 'order-service'))).status).toBe(401);
    });

    it('refuses user-facing reasons and a malformed user id', async () => {
      const body = { reason: 'reuse_detected' };
      expect((await post(path(), body, signed(body))).status).toBe(400);

      const valid = { reason: 'admin' };
      const badPath = '/internal/auth/users/not-a-uuid/revoke-sessions';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = randomUUID();
      const headers = {
        [INTERNAL_AUTH_HEADERS.service]: 'user-service',
        [INTERNAL_AUTH_HEADERS.timestamp]: timestamp,
        [INTERNAL_AUTH_HEADERS.nonce]: nonce,
        [INTERNAL_AUTH_HEADERS.signature]: signInternalRequest({ method: 'POST', path: badPath, timestamp, nonce, body: valid, service: 'user-service', secret: INTERNAL_SECRET }),
      };
      expect((await post(badPath, valid, headers)).status).toBe(400);
    });
  });
});
