import { AdminRestaurantsService } from './admin-restaurants.service';
import { AdminListRestaurantsQueryDto } from '../dto/admin-restaurants.dto';

const restaurant = (id: string, ownerId: string) => ({
  id,
  ownerId,
  name: 'Zooba',
  status: 'OPEN',
  approvalStatus: 'APPROVED',
  address: 'Zamalek',
  latitude: 30.06,
  longitude: 31.22,
  deliveryRadiusKm: '5.00',
  contactPhone: '+201011111111',
  submittedAt: null,
  approvedAt: null,
  taxCardNumber: '123',
  commercialRegistrationNumber: '456',
  createdAt: new Date('2026-11-01T00:00:00Z'),
});

const setup = () => {
  const restaurants = { findForAdmin: jest.fn(), findByContactPhone: jest.fn(), findById: jest.fn() };
  const restaurantsService = { getApplicationForStaff: jest.fn() };
  const menu = { menuReadiness: jest.fn() };
  const lookups = { names: jest.fn(), ordersToday: jest.fn() };
  return {
    service: new AdminRestaurantsService(restaurants as never, restaurantsService as never, menu as never, lookups as never),
    restaurants,
    restaurantsService,
    menu,
    lookups,
  };
};

describe('AdminRestaurantsService (#214)', () => {
  it('passes the area only when all three of its parameters are given, and adds owner names', async () => {
    const { service, restaurants, lookups } = setup();
    restaurants.findForAdmin.mockResolvedValue([[restaurant('r1', 'o1')], 1]);
    lookups.names.mockResolvedValue(new Map([['o1', 'Mona Ali']]));

    const result = await service.list(Object.assign(new AdminListRestaurantsQueryDto(), { nearLat: 30, nearLng: 31, withinKm: 5, q: 'zo' }));

    expect(restaurants.findForAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ namePrefix: 'zo', near: { latitude: 30, longitude: 31, withinKm: 5 } }),
      1,
      20,
    );
    expect(result.items[0]).toMatchObject({ id: 'r1', ownerName: 'Mona Ali' });
    expect(result.items[0]).not.toHaveProperty('taxCardNumber');
  });

  it('searches by the exact phone', async () => {
    const { service, restaurants, lookups } = setup();
    restaurants.findByContactPhone.mockResolvedValue([restaurant('r1', 'o1')]);
    lookups.names.mockResolvedValue(null);
    const result = await service.search('+201011111111');
    expect(restaurants.findByContactPhone).toHaveBeenCalledWith('+201011111111');
    expect(result.items[0].ownerName).toBeNull();
  });

  it('builds the page, with null parts when menu-service or order-service do not answer', async () => {
    const { service, restaurants, restaurantsService, menu, lookups } = setup();
    restaurantsService.getApplicationForStaff.mockResolvedValue({ id: 'r1', reviews: [] });
    restaurants.findById.mockResolvedValue(restaurant('r1', 'o1'));
    lookups.names.mockResolvedValue(new Map([['o1', 'Mona Ali']]));
    menu.menuReadiness.mockResolvedValueOnce({ categories: 3, availableItems: 12 });
    lookups.ordersToday.mockResolvedValueOnce(9);

    await expect(service.detail('r1')).resolves.toMatchObject({ menu: { categories: 3, availableItems: 12 }, ordersToday: 9, restaurant: { ownerName: 'Mona Ali' } });

    menu.menuReadiness.mockRejectedValueOnce(new Error('down'));
    lookups.ordersToday.mockResolvedValueOnce(null);
    await expect(service.detail('r1')).resolves.toMatchObject({ menu: null, ordersToday: null });
  });
});
