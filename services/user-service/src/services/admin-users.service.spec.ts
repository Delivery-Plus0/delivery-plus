import { UserRole } from '@food-delivery/shared';
import { AdminUsersService, DIRECTORY_MATCH_CAP } from './admin-users.service';
import { AdminListUsersQueryDto } from '../dto/admin-users.dto';

const profile = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  fullName: `Person ${id}`,
  email: `${id}@example.com`,
  phone: '+201000000000',
  phoneVerifiedAt: new Date('2026-11-01T00:00:00Z'),
  address: 'Zamalek',
  avatarUrl: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  ...extra,
});
const account = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  email: `${id}@example.com`,
  role: UserRole.CUSTOMER,
  status: 'ACTIVE',
  emailVerified: true,
  suspendedAt: null,
  suspendedReason: null,
  lastLoginAt: '2026-11-20T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
  ...extra,
});

const setup = () => {
  const profiles = {
    pageForAdmin: jest.fn(),
    idsForAdmin: jest.fn(),
    findByIds: jest.fn(),
    findForAdminSearch: jest.fn(),
    findById: jest.fn(),
  };
  const accounts = { queryAccounts: jest.fn() };
  const linked = { driverIdFor: jest.fn(), restaurantIdsFor: jest.fn() };
  return { service: new AdminUsersService(profiles as never, accounts as never, linked as never), profiles, accounts, linked };
};
const query = (extra: Partial<AdminListUsersQueryDto> = {}) => Object.assign(new AdminListUsersQueryDto(), extra);

describe('AdminUsersService (#214)', () => {
  it('pages profiles and adds their accounts when only profile filters apply', async () => {
    const { service, profiles, accounts } = setup();
    profiles.pageForAdmin.mockResolvedValue([[profile('a'), profile('b')], 42]);
    accounts.queryAccounts.mockResolvedValue({ items: [account('a'), account('b', { status: 'SUSPENDED' })], total: 2 });

    const result = await service.list(query({ q: 'Ah', phoneVerified: true, page: 2, limit: 2 }));

    expect(profiles.pageForAdmin).toHaveBeenCalledWith({ namePrefix: 'Ah', phoneVerified: true }, 2, 2);
    expect(accounts.queryAccounts).toHaveBeenCalledWith({ ids: ['a', 'b'], page: 1, limit: 2 }, undefined);
    expect(result).toMatchObject({ page: 2, limit: 2, total: 42, totalPages: 21 });
    expect(result.items[1]).toMatchObject({ id: 'b', status: 'SUSPENDED', phoneVerified: true, fullName: 'Person b' });
  });

  it('lets auth-service page when only account filters apply', async () => {
    const { service, profiles, accounts } = setup();
    accounts.queryAccounts.mockResolvedValue({ items: [account('d', { role: UserRole.DRIVER })], total: 1 });
    profiles.findByIds.mockResolvedValue([profile('d')]);

    const result = await service.list(query({ role: 'DRIVER', status: 'ACTIVE', createdFrom: '2026-11-01T00:00:00Z' }));

    expect(accounts.queryAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ roles: [UserRole.DRIVER], status: 'ACTIVE', createdFrom: '2026-11-01T00:00:00Z', ids: undefined, page: 1, limit: 20 }),
      undefined,
    );
    expect(profiles.pageForAdmin).not.toHaveBeenCalled();
    expect(result.items).toEqual([expect.objectContaining({ id: 'd', role: UserRole.DRIVER, fullName: 'Person d' })]);
  });

  it('narrows auth-service to the profile matches when both kinds of filter apply', async () => {
    const { service, profiles, accounts } = setup();
    profiles.idsForAdmin.mockResolvedValue(['a', 'c']);
    accounts.queryAccounts.mockResolvedValue({ items: [account('c')], total: 1 });
    profiles.findByIds.mockResolvedValue([profile('c')]);

    await service.list(query({ q: 'Mo', status: 'SUSPENDED' }));

    expect(profiles.idsForAdmin).toHaveBeenCalledWith({ namePrefix: 'Mo', phoneVerified: undefined }, DIRECTORY_MATCH_CAP);
    expect(accounts.queryAccounts).toHaveBeenCalledWith(expect.objectContaining({ ids: ['a', 'c'], status: 'SUSPENDED' }), undefined);
  });

  it('answers an empty page without calling auth-service when no profile matches, and refuses a too-broad combination', async () => {
    const { service, profiles, accounts } = setup();
    profiles.idsForAdmin.mockResolvedValueOnce([]);
    await expect(service.list(query({ q: 'Zz', role: 'CUSTOMER' }))).resolves.toMatchObject({ items: [], total: 0 });
    expect(accounts.queryAccounts).not.toHaveBeenCalled();

    profiles.idsForAdmin.mockResolvedValueOnce(Array.from({ length: DIRECTORY_MATCH_CAP + 1 }, (_, i) => `id-${i}`));
    await expect(service.list(query({ phoneVerified: true, role: 'CUSTOMER' }))).rejects.toThrow('narrow them down');
  });

  it('searches by exactly one exact phone or email', async () => {
    const { service, profiles, accounts } = setup();
    profiles.findForAdminSearch.mockResolvedValue([profile('a')]);
    accounts.queryAccounts.mockResolvedValue({ items: [account('a')], total: 1 });

    await expect(service.search({ phone: '+201012345678' })).resolves.toEqual({ items: [expect.objectContaining({ id: 'a' })] });
    expect(profiles.findForAdminSearch).toHaveBeenCalledWith({ phone: '+201012345678' });
    await expect(service.search({})).rejects.toThrow('exactly one');
    await expect(service.search({ phone: '+201012345678', email: 'a@example.com' })).rejects.toThrow('exactly one');
  });

  it('shows one person with the address and a pointer to the audit trail, and 404s an unknown id', async () => {
    const { service, profiles, accounts } = setup();
    profiles.findById.mockResolvedValueOnce(profile('a'));
    accounts.queryAccounts.mockResolvedValueOnce({ items: [account('a')], total: 1 });
    await expect(service.detail('a')).resolves.toMatchObject({ id: 'a', address: 'Zamalek', auditTrail: { targetType: 'USER', targetId: 'a' } });

    profiles.findById.mockResolvedValueOnce(null);
    accounts.queryAccounts.mockResolvedValueOnce({ items: [], total: 0 });
    await expect(service.detail('missing')).rejects.toThrow('User not found');
  });

  it('never exposes secret fields: the staff view has a fixed shape', async () => {
    const { service, profiles, accounts } = setup();
    profiles.findById.mockResolvedValue(profile('a', { authCredentialId: 'a', createdByService: 'auth-service' }));
    accounts.queryAccounts.mockResolvedValue({ items: [{ ...account('a'), passwordHash: 'leak', verificationTokenHash: 'leak' }], total: 1 });
    const view = await service.detail('a');
    expect(Object.keys(view).sort()).toMatchInlineSnapshot(`
[
  "address",
  "auditTrail",
  "avatarUrl",
  "createdAt",
  "email",
  "emailVerified",
  "fullName",
  "id",
  "lastLoginAt",
  "linked",
  "phone",
  "phoneVerified",
  "role",
  "status",
  "suspendedAt",
  "suspendedReason",
]
`);
    expect(JSON.stringify(view)).not.toContain('leak');
  });

  it("links a DRIVER account to its driver record, and says so when driver-service doesn't answer", async () => {
    const { service, profiles, accounts, linked } = setup();
    profiles.findById.mockResolvedValue(profile('d'));
    accounts.queryAccounts.mockResolvedValue({ items: [account('d', { role: UserRole.DRIVER })], total: 1 });
    linked.driverIdFor.mockResolvedValueOnce('driver-1');
    await expect(service.detail('d')).resolves.toMatchObject({ linked: { driverId: 'driver-1' } });
    linked.driverIdFor.mockResolvedValueOnce(undefined);
    await expect(service.detail('d')).resolves.toMatchObject({ linked: { driverId: 'unavailable' } });
  });

  it('does not look up a driver for a customer', async () => {
    const { service, profiles, accounts, linked } = setup();
    profiles.findById.mockResolvedValue(profile('a'));
    accounts.queryAccounts.mockResolvedValue({ items: [account('a')], total: 1 });
    await expect(service.detail('a')).resolves.toMatchObject({ linked: { driverId: null, restaurantIds: [] } });
    expect(linked.driverIdFor).not.toHaveBeenCalled();
    expect(linked.restaurantIdsFor).not.toHaveBeenCalled();
  });

  it("links an owner to their restaurants, and says so when restaurant-service doesn't answer", async () => {
    const { service, profiles, accounts, linked } = setup();
    profiles.findById.mockResolvedValue(profile('o'));
    accounts.queryAccounts.mockResolvedValue({ items: [account('o', { role: UserRole.RESTAURANT_OWNER })], total: 1 });
    linked.restaurantIdsFor.mockResolvedValueOnce(['r1']);
    await expect(service.detail('o')).resolves.toMatchObject({ linked: { driverId: null, restaurantIds: ['r1'] } });
    linked.restaurantIdsFor.mockResolvedValueOnce(undefined);
    await expect(service.detail('o')).resolves.toMatchObject({ linked: { restaurantIds: 'unavailable' } });
  });
});
