import { DriverStatus } from '@food-delivery/shared';
import { DriverServiceClient } from '../common/driver-service.client';
import { UserServiceClient } from '../common/user-service.client';
import { DriverCardService, firstName } from './driver-card.service';

describe('DriverCardService (#140)', () => {
  const driver = {
    id: 'driver-1',
    userId: 'user-1',
    status: DriverStatus.BUSY,
    vehicleType: 'Scooter',
    licensePlate: 'ABC 123',
  };
  const profile = {
    id: 'user-1',
    fullName: 'Omar Hassan Ali',
    avatarUrl: 'https://cdn.test/u/1.jpg',
    // Fields that must never reach a card:
    email: 'omar@example.com',
    phone: '+201092784342',
    address: '1 Private St',
  };

  const setup = () => {
    const drivers = { getDriver: jest.fn(async () => driver) };
    const users = { getProfile: jest.fn(async () => profile) };
    const service = new DriverCardService(
      drivers as unknown as DriverServiceClient,
      users as unknown as UserServiceClient,
    );
    return { service, drivers, users };
  };

  it('composes first name, photo, vehicle and plate; nothing else', async () => {
    const { service, drivers, users } = setup();

    const card = await service.getCard('driver-1');

    expect(card).toEqual({
      displayName: 'Omar',
      avatarUrl: 'https://cdn.test/u/1.jpg',
      vehicleType: 'Scooter',
      licensePlate: 'ABC 123',
    });
    expect(Object.keys(card!).sort()).toEqual(['avatarUrl', 'displayName', 'licensePlate', 'vehicleType']);
    expect(JSON.stringify(card)).not.toMatch(/omar@example|\+20|Private|user-1/);
    expect(drivers.getDriver).toHaveBeenCalledWith('driver-1');
    expect(users.getProfile).toHaveBeenCalledWith('user-1');
  });

  it('missing optional fields become null (no undefined leaks to clients)', async () => {
    const { service, drivers, users } = setup();
    drivers.getDriver.mockResolvedValue({ ...driver, vehicleType: undefined, licensePlate: '' } as never);
    users.getProfile.mockResolvedValue({ ...profile, avatarUrl: undefined } as never);

    expect(await service.getCard('driver-1')).toEqual({
      displayName: 'Omar',
      avatarUrl: null,
      vehicleType: null,
      licensePlate: null,
    });
  });

  it.each([
    ['driver-service is down', 'drivers'],
    ['user-service is down', 'users'],
  ])('returns null when %s, so the delivery read still succeeds', async (_label, which) => {
    const { service, drivers, users } = setup();
    (which === 'drivers' ? drivers.getDriver : users.getProfile).mockRejectedValue(new Error('down'));

    await expect(service.getCard('driver-1')).resolves.toBeNull();
  });

  it('caches a card for a minute, then refreshes it', async () => {
    const { service, drivers } = setup();
    await service.getCard('driver-1', 0);
    await service.getCard('driver-1', 59_000);
    expect(drivers.getDriver).toHaveBeenCalledTimes(1);

    await service.getCard('driver-1', 61_000);
    expect(drivers.getDriver).toHaveBeenCalledTimes(2);
  });

  it('a failed lookup is not cached', async () => {
    const { service, drivers } = setup();
    drivers.getDriver.mockRejectedValueOnce(new Error('down'));
    expect(await service.getCard('driver-1', 0)).toBeNull();
    expect(await service.getCard('driver-1', 1_000)).not.toBeNull();
  });

  describe('firstName', () => {
    it.each([
      ['Omar Hassan', 'Omar'],
      ['  Sara  ', 'Sara'],
      ['أحمد محمد', 'أحمد'],
      ['', 'Your driver'],
      [undefined, 'Your driver'],
    ])('%j → %j', (input, expected) => {
      expect(firstName(input as string | undefined)).toBe(expected);
    });
  });
});
