import { Module, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import {
  AllExceptionsFilter,
  JwtAuthGuard,
  PERMISSIONS_KEY,
  PermissionsGuard,
  PrivateDocumentStorage,
  RATE_LIMIT_KEY,
  RateLimitGuard,
  RateLimiterService,
  ROLES_KEY,
  RolesGuard,
  UserRole,
} from '@food-delivery/shared';
import { DriverApplicationController } from './driver-application.controller';
import { DriversService } from '../services/drivers.service';
import { DRIVER_DOCUMENT_STORAGE, DriverApplicationService } from '../services/driver-application.service';
import { DriversRepository } from '../repositories/drivers.repository';
import { DriverApplicationRepository } from '../repositories/driver-application.repository';
import { UserServiceClient } from '../common/user-service.client';
import { LOCAL_NATIONAL_ID_HMAC_SECRET } from '../config/app-config';

describe('DriverApplicationController guards (#207)', () => {
  const handler = (name: keyof DriverApplicationController) => DriverApplicationController.prototype[name];

  it('lets only the driver work on their own application', () => {
    for (const name of ['getMine', 'saveMine', 'createUpload', 'confirmUpload', 'submitMine'] as const) {
      expect(Reflect.getMetadata(ROLES_KEY, handler(name))).toEqual([UserRole.DRIVER]);
    }
  });

  it('gives staff routes to ADMIN tokens holding onboarding.review only', () => {
    for (const name of ['getForStaff', 'createReadUrl', 'review'] as const) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard, PermissionsGuard]));
      expect(Reflect.getMetadata(ROLES_KEY, handler(name))).toEqual([UserRole.ADMIN]);
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handler(name))).toEqual(['onboarding.review']);
    }
  });

  it('rate-limits upload URLs, confirms and staff reads', () => {
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler('createUpload'))).toEqual({ limit: 20, windowSeconds: 3600 });
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler('confirmUpload'))).toEqual({ limit: 30, windowSeconds: 3600 });
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler('createReadUrl'))).toEqual({ limit: 60, windowSeconds: 60 });
    for (const name of ['createUpload', 'confirmUpload', 'createReadUrl'] as const) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler(name))).toContain(RateLimitGuard);
    }
  });
});

const jwtSecret = 'test-jwt-secret';
const driverUserId = '77777777-7777-41d4-a716-446655440000';
const driverId = '88888888-8888-41d4-a716-446655440000';
const staffUserId = '99999999-9999-41d4-a716-446655440000';

const drivers = { findByUserId: jest.fn() };
const applications = {
  findApplication: jest.fn(),
  currentDocuments: jest.fn(),
  reviews: jest.fn().mockResolvedValue([]),
  documentVersions: jest.fn().mockResolvedValue([]),
  findCurrentDocumentWithKey: jest.fn(),
  recordAccess: jest.fn(),
  decideIfSubmitted: jest.fn(),
};
const storage = { createReadUrl: jest.fn(), createUpload: jest.fn(), promote: jest.fn() };
const limiter = { incrementAndCheck: jest.fn() };

@Module({
  imports: [JwtModule.register({ secret: jwtSecret })],
  controllers: [DriverApplicationController],
  providers: [
    { provide: RateLimiterService, useValue: limiter },
    { provide: DRIVER_DOCUMENT_STORAGE, useValue: storage as unknown as PrivateDocumentStorage },
    {
      provide: DriversService,
      useFactory: () =>
        new DriversService(drivers as unknown as DriversRepository, {} as UserServiceClient, { phoneVerificationRequired: false, autoVerifyDrivers: false } as never),
    },
    {
      provide: DriverApplicationService,
      useFactory: () =>
        new DriverApplicationService(
          applications as unknown as DriverApplicationRepository,
          storage as unknown as PrivateDocumentStorage,
          { nationalIdHmacSecret: LOCAL_NATIONAL_ID_HMAC_SECRET } as never,
        ),
    },
  ],
})
class DriverApplicationTestModule {}

describe('driver documents over HTTP (#207)', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;
  let tokens: Record<'driver' | 'reviewer' | 'otherStaff' | 'customer', string>;

  const pendingDriver = { id: driverId, userId: driverUserId, verificationStatus: 'PENDING', submittedAt: null, verificationNote: null };
  const selfie = {
    id: 'doc-1',
    driverId,
    type: 'selfie',
    version: 2,
    isCurrent: true,
    objectKey: `drivers/${driverId}/documents/selfie/01234567-89ab-cdef-0123-456789abcdef.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 100,
    sha256: 'a'.repeat(64),
    uploadedAt: new Date('2026-11-07T10:00:00Z'),
  };

  beforeAll(async () => {
    app = await NestFactory.create(DriverApplicationTestModule, { logger: false, abortOnError: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter({ log: jest.fn() } as never));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    const jwt = app.get(JwtService);
    tokens = {
      driver: jwt.sign({ sub: driverUserId, email: 'd@example.com', role: UserRole.DRIVER }),
      reviewer: jwt.sign({ sub: staffUserId, email: 's@example.com', role: UserRole.ADMIN, perms: ['onboarding.review'] }),
      otherStaff: jwt.sign({ sub: staffUserId, email: 's@example.com', role: UserRole.ADMIN, perms: ['support.read', 'ops.act'] }),
      customer: jwt.sign({ sub: driverUserId, email: 'c@example.com', role: UserRole.CUSTOMER, perms: ['onboarding.review'] }),
    };
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    for (const fn of [...Object.values(drivers), ...Object.values(applications), ...Object.values(storage), ...Object.values(limiter)]) fn.mockReset();
    limiter.incrementAndCheck.mockResolvedValue(true);
    drivers.findByUserId.mockResolvedValue(pendingDriver);
    applications.findApplication.mockResolvedValue({ ...pendingDriver, nationalIdLast4: null, drivingLicenceExpiresOn: null, vehicleLicenceExpiresOn: null });
    applications.currentDocuments.mockResolvedValue([selfie]);
    applications.reviews.mockResolvedValue([]);
    applications.documentVersions.mockResolvedValue([]);
    applications.findCurrentDocumentWithKey.mockResolvedValue(selfie);
    applications.recordAccess.mockResolvedValue({});
    storage.createReadUrl.mockResolvedValue({ url: 'https://signed.example/selfie?X-Amz-Signature=abc', expiresIn: 300 });
  });

  const readUrl = (token?: string) =>
    fetch(`${baseUrl}/drivers/${driverId}/documents/selfie/read-url`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  it('gives a reviewer a five-minute URL, not cacheable, and records the read', async () => {
    const response = await readUrl(tokens.reviewer);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      type: 'selfie',
      version: 2,
      contentType: 'image/jpeg',
      url: 'https://signed.example/selfie?X-Amz-Signature=abc',
      expiresIn: 300,
    });
    expect(applications.recordAccess).toHaveBeenCalledWith(expect.objectContaining({ staffUserId, driverId, documentType: 'selfie' }));
  });

  it.each([
    ['no token', undefined, 401],
    ['the driver themself', 'driver', 403],
    ['a customer token claiming the permission', 'customer', 403],
    ['staff without onboarding.review', 'otherStaff', 403],
  ] as const)('refuses %s and issues nothing', async (_label, who, status) => {
    const response = await readUrl(who ? tokens[who] : undefined);

    expect(response.status).toBe(status);
    expect(storage.createReadUrl).not.toHaveBeenCalled();
    expect(applications.recordAccess).not.toHaveBeenCalled();
  });

  it('answers 429 past the staff read limit', async () => {
    limiter.incrementAndCheck.mockResolvedValue(false);
    expect((await readUrl(tokens.reviewer)).status).toBe(429);
    expect(storage.createReadUrl).not.toHaveBeenCalled();
  });

  it("never puts a URL or object key in the driver's own application", async () => {
    const response = await fetch(`${baseUrl}/drivers/me/application`, { headers: { Authorization: `Bearer ${tokens.driver}` } });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toMatch(/https?:|objectKey|drivers\//);
    expect(JSON.parse(body)).toMatchObject({ driverId, status: 'DRAFT', documents: [{ type: 'selfie', version: 2 }] });
  });

  it('routes /drivers/me/application to the driver, not to the staff :id route', async () => {
    const response = await fetch(`${baseUrl}/drivers/me/application`, { headers: { Authorization: `Bearer ${tokens.reviewer}` } });
    expect(response.status).toBe(403);
  });

  it('validates the national ID before anything is stored', async () => {
    const response = await fetch(`${baseUrl}/drivers/me/application`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokens.driver}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ nationalIdNumber: '12345', drivingLicenceExpiresOn: '2028-05-31', vehicleLicenceExpiresOn: '2027-01-15' }),
    });
    expect(response.status).toBe(400);
  });

  it('refuses an upload content type that is not allowed', async () => {
    const response = await fetch(`${baseUrl}/drivers/me/documents/selfie/upload-url`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.driver}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'text/html' }),
    });
    expect(response.status).toBe(400);
    expect(storage.createUpload).not.toHaveBeenCalled();
  });
  describe('POST /drivers/:id/application/review', () => {
    const submittedAt = '2026-11-08T09:00:00.000Z';
    const review = (token: string | undefined, body: unknown) =>
      fetch(`${baseUrl}/drivers/${driverId}/application/review`, {
        method: 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    beforeEach(() => {
      applications.decideIfSubmitted.mockResolvedValue('decided');
    });

    it('records a rejection with the reviewer from the token and returns the application with its history', async () => {
      const response = await review(tokens.reviewer, { decision: 'REJECTED', note: '  Selfie is blurry ', submittedAt });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ driverId, reviews: [] });
      expect(applications.decideIfSubmitted).toHaveBeenCalledWith(
        driverId,
        { decision: 'REJECTED', note: 'Selfie is blurry', reviewerUserId: staffUserId, submittedAt: new Date(submittedAt) },
        expect.any(Function),
      );
    });

    it.each([
      ['a rejection without a note', { decision: 'REJECTED', submittedAt }],
      ['an unknown decision', { decision: 'APPROVED', submittedAt }],
      ['no submittedAt', { decision: 'VERIFIED' }],
      ['a reviewer field in the body', { decision: 'VERIFIED', submittedAt, reviewerUserId: driverUserId }],
    ])('refuses %s with 400', async (_label, body) => {
      expect((await review(tokens.reviewer, body)).status).toBe(400);
      expect(applications.decideIfSubmitted).not.toHaveBeenCalled();
    });

    it.each([
      ['no token', undefined, 401],
      ['the driver themself', 'driver', 403],
      ['a customer token claiming the permission', 'customer', 403],
      ['staff without onboarding.review', 'otherStaff', 403],
    ] as const)('refuses %s and decides nothing', async (_label, who, status) => {
      expect((await review(who ? tokens[who] : undefined, { decision: 'VERIFIED', submittedAt })).status).toBe(status);
      expect(applications.decideIfSubmitted).not.toHaveBeenCalled();
    });
  });
});
