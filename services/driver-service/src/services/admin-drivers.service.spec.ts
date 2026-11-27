import { AdminDriversService } from './admin-drivers.service';
import { AdminDriverQueueQueryDto, AdminListDriversQueryDto } from '../dto/admin-drivers.dto';

const driver = (id: string, userId: string) => ({
  id,
  userId,
  vehicleType: 'Scooter',
  licensePlate: 'ABC 1',
  status: 'OFFLINE',
  verificationStatus: 'PENDING',
  submittedAt: new Date('2026-11-20T00:00:00Z'),
  verifiedAt: null,
  drivingLicenceExpiresOn: '2027-01-01',
  vehicleLicenceExpiresOn: '2027-02-01',
  nationalIdHash: 'secret-hash',
  createdAt: new Date('2026-11-01T00:00:00Z'),
});

const setup = () => {
  const drivers = { findForAdmin: jest.fn(), findById: jest.fn() };
  const applications = { getApplicationForStaff: jest.fn() };
  const lookups = { names: jest.fn(), driverSummary: jest.fn() };
  return { service: new AdminDriversService(drivers as never, applications as never, lookups as never), drivers, applications, lookups };
};
const listQuery = (extra: Partial<AdminListDriversQueryDto> = {}) => Object.assign(new AdminListDriversQueryDto(), extra);

describe('AdminDriversService (#214)', () => {
  it('lists drivers with their names, and turns "expiring within N days" into a Cairo date', async () => {
    const { service, drivers, lookups } = setup();
    drivers.findForAdmin.mockResolvedValue([[driver('d1', 'u1')], 41]);
    lookups.names.mockResolvedValue(new Map([['u1', 'Ali Hassan']]));

    const result = await service.list(listQuery({ licenceExpiringWithinDays: 30, q: 'ABC', limit: 20 }), new Date('2026-11-27T23:30:00Z'));

    expect(drivers.findForAdmin).toHaveBeenCalledWith(expect.objectContaining({ platePrefix: 'ABC', licenceExpiringBy: '2026-12-28' }), 1, 20);
    expect(result).toMatchObject({ total: 41, totalPages: 3 });
    expect(result.items[0]).toMatchObject({ id: 'd1', fullName: 'Ali Hassan' });
    expect(result.items[0]).not.toHaveProperty('nationalIdHash');
  });

  it('shows names as null, never made up, when user-service does not answer', async () => {
    const { service, drivers, lookups } = setup();
    drivers.findForAdmin.mockResolvedValue([[driver('d1', 'u1')], 1]);
    lookups.names.mockResolvedValue(null);
    expect((await service.list(listQuery())).items[0].fullName).toBeNull();
  });

  it('pages the review queue', async () => {
    const { service, drivers, lookups } = setup();
    drivers.findForAdmin.mockResolvedValue([[], 0]);
    lookups.names.mockResolvedValue(new Map());
    await service.queue(Object.assign(new AdminDriverQueueQueryDto(), { page: 2, limit: 10 }));
    expect(drivers.findForAdmin).toHaveBeenCalledWith({ queue: true }, 2, 10);
  });

  it('builds the driver page from the application, the name and the delivery summary', async () => {
    const { service, drivers, applications, lookups } = setup();
    applications.getApplicationForStaff.mockResolvedValue({ id: 'd1', reviews: [] });
    drivers.findById.mockResolvedValue(driver('d1', 'u1'));
    lookups.names.mockResolvedValue(new Map([['u1', 'Ali Hassan']]));
    lookups.driverSummary.mockResolvedValue({ earnings: { currency: 'EGP', pending: '0.00', available: '6.25', balance: '6.25' }, rating: { average: 4.5, count: 2 } });

    const page = await service.detail('d1');

    expect(page.driver).toMatchObject({ id: 'd1', fullName: 'Ali Hassan' });
    expect(page.application).toEqual({ id: 'd1', reviews: [] });
    expect(page.summary?.earnings.balance).toBe('6.25');
  });

  it('404s an unknown driver through the application lookup', async () => {
    const { service, applications } = setup();
    applications.getApplicationForStaff.mockRejectedValue(new Error('Driver not found'));
    await expect(service.detail('missing')).rejects.toThrow('Driver not found');
  });
});
