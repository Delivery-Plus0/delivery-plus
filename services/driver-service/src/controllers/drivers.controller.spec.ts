import { Module, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AllExceptionsFilter, DriverStatus, JwtAuthGuard, ROLES_KEY, RolesGuard, UserRole } from '@food-delivery/shared';
import { DriversController } from './drivers.controller';
import { DriversService } from '../services/drivers.service';
import { DriversRepository } from '../repositories/drivers.repository';
import { UserServiceClient } from '../common/user-service.client';

describe('DriversController', () => {
  const handler = (name: keyof DriversController) => DriversController.prototype[name];

  it('GET /drivers/available is no longer anonymous: JWT + ADMIN (service system tokens) only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('listAvailable'))).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, handler('listAvailable'))).toEqual([UserRole.ADMIN]);
  });

  it('GET /drivers/:id requires a JWT from a driver (self, checked in the service) or admin', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('getById'))).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, handler('getById'))).toEqual([UserRole.DRIVER, UserRole.ADMIN]);
  });

  it('lets only the driver change their own vehicle, and only admins set verification (#147)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('updateMyVehicle'))).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, handler('updateMyVehicle'))).toEqual([UserRole.DRIVER]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('setVerification'))).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, handler('setVerification'))).toEqual([UserRole.ADMIN]);
  });
});

const jwtSecret = 'test-jwt-secret';
const userId = '77777777-7777-41d4-a716-446655440000';

const drivers = {
  findByUserId: jest.fn(),
  findById: jest.fn(),
  transitionStatus: jest.fn(),
};

/** The real DriversService behind the real guards, pipe and filter (#206). */
@Module({
  imports: [JwtModule.register({ secret: jwtSecret })],
  controllers: [DriversController],
  providers: [
    {
      provide: DriversService,
      useFactory: () =>
        new DriversService(
          drivers as unknown as DriversRepository,
          { getOwnProfile: jest.fn() } as unknown as UserServiceClient,
          { phoneVerificationRequired: false, autoVerifyDrivers: false } as never,
        ),
    },
  ],
})
class DriversControllerTestModule {}

describe('POST /drivers/me/online: the verification gate over HTTP (#206)', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;
  let token: string;

  const driver = (verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED') => ({
    id: '88888888-8888-41d4-a716-446655440000',
    userId,
    vehicleType: 'Scooter',
    licensePlate: 'QA-0001',
    status: DriverStatus.OFFLINE,
    verificationStatus,
    verificationNote: null,
    verifiedAt: null,
  });

  beforeAll(async () => {
    app = await NestFactory.create(DriversControllerTestModule, { logger: false, abortOnError: false });
    // The same pipe and filter as main.ts.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter({ log: jest.fn() } as never));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    token = app.get(JwtService).sign({ sub: userId, email: 'd@example.com', role: UserRole.DRIVER });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    Object.values(drivers).forEach((fn) => fn.mockReset());
  });

  const goOnline = () =>
    fetch(`${baseUrl}/drivers/me/online`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

  it.each(['PENDING', 'REJECTED'] as const)('answers 403 DriverNotVerified to a %s driver and writes nothing', async (status) => {
    drivers.findByUserId.mockResolvedValue(driver(status));

    const response = await goOnline();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      statusCode: 403,
      error: 'DriverNotVerified',
      details: { verificationStatus: status },
    });
    expect(drivers.transitionStatus).not.toHaveBeenCalled();
  });

  it('puts a VERIFIED driver online', async () => {
    drivers.findByUserId.mockResolvedValue(driver('VERIFIED'));
    drivers.transitionStatus.mockResolvedValue({ ...driver('VERIFIED'), status: DriverStatus.AVAILABLE });

    const response = await goOnline();

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ status: DriverStatus.AVAILABLE });
  });
});
