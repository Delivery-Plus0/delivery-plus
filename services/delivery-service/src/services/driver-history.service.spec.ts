import { DeliveryStatus, DriverStatus } from '@food-delivery/shared';
import { DriverServiceClient } from '../common/driver-service.client';
import { OrderDto, OrderServiceClient } from '../common/order-service.client';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import { Delivery } from '../entities/delivery.entity';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { DriverHistoryService } from './driver-history.service';

const AUTH = 'Bearer driver-token';

const delivered = (id: string, orderId: string): Delivery =>
  ({
    id,
    orderId,
    customerId: 'customer-1',
    driverId: 'driver-1',
    status: DeliveryStatus.DELIVERED,
    assignedAt: new Date('2026-10-07T10:00:00Z'),
    pickedUpAt: new Date('2026-10-07T10:10:00Z'),
    deliveredAt: new Date('2026-10-07T10:30:00Z'),
    cancelledAt: null,
    createdAt: new Date('2026-10-07T09:55:00Z'),
    updatedAt: new Date('2026-10-07T10:30:00Z'),
  }) as Delivery;

const order = (id: string, restaurantId = 'restaurant-1'): OrderDto =>
  ({
    id,
    customerId: 'customer-1',
    restaurantId,
    status: 'DELIVERED',
    totalAmount: '19.98',
    items: [{ name: 'QA Burger', quantity: 2 }],
    deliveryAddress: '1 Test Street, Apt 1',
    deliveryNotes: 'Call me on +201000000000',
    deliveryLatitude: 30.04,
    deliveryLongitude: 31.23,
  }) as unknown as OrderDto;

describe('DriverHistoryService', () => {
  let deliveries: jest.Mocked<Pick<DeliveriesRepository, 'findPageByDriverId'>>;
  let driverClient: jest.Mocked<Pick<DriverServiceClient, 'getOwnProfile'>>;
  let orderClient: jest.Mocked<Pick<OrderServiceClient, 'getOrder'>>;
  let restaurantClient: jest.Mocked<Pick<RestaurantServiceClient, 'getRestaurant'>>;
  let service: DriverHistoryService;

  beforeEach(() => {
    deliveries = { findPageByDriverId: jest.fn().mockResolvedValue([[], 0]) };
    driverClient = {
      getOwnProfile: jest.fn().mockResolvedValue({ id: 'driver-1', userId: 'user-1', status: DriverStatus.AVAILABLE }),
    };
    orderClient = { getOrder: jest.fn().mockImplementation(async (id: string) => order(id)) };
    restaurantClient = {
      getRestaurant: jest.fn().mockResolvedValue({ id: 'restaurant-1', name: 'QA Kitchen', address: '9 Kitchen Road' }),
    };
    service = new DriverHistoryService(
      deliveries as unknown as DeliveriesRepository,
      driverClient as unknown as DriverServiceClient,
      orderClient as unknown as OrderServiceClient,
      restaurantClient as unknown as RestaurantServiceClient,
    );
  });

  it("pages only the calling driver's deliveries, resolved from the token", async () => {
    await service.getForDriver(AUTH, { page: 2, limit: 10 });

    expect(driverClient.getOwnProfile).toHaveBeenCalledWith(AUTH);
    expect(deliveries.findPageByDriverId).toHaveBeenCalledWith('driver-1', null, 2, 10);
  });

  it('returns an empty page for a user with no driver profile yet', async () => {
    driverClient.getOwnProfile.mockResolvedValue(null);

    await expect(service.getForDriver(AUTH, { page: 1, limit: 20 })).resolves.toEqual({
      items: [],
      page: 1,
      limit: 20,
      total: 0,
      totalPages: 1,
    });
    expect(deliveries.findPageByDriverId).not.toHaveBeenCalled();
  });

  it.each([
    ['active', [DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.PICKED_UP, DeliveryStatus.IN_TRANSIT]],
    ['completed', [DeliveryStatus.DELIVERED]],
    ['cancelled', [DeliveryStatus.CANCELLED]],
  ] as const)('maps the %s filter to delivery statuses', async (status, statuses) => {
    await service.getForDriver(AUTH, { status, page: 1, limit: 20 });

    expect(deliveries.findPageByDriverId).toHaveBeenCalledWith('driver-1', statuses, 1, 20);
  });

  it('reports paging totals', async () => {
    deliveries.findPageByDriverId.mockResolvedValue([[delivered('d-1', 'o-1')], 21]);

    const page = await service.getForDriver(AUTH, { page: 3, limit: 10 });

    expect(page).toMatchObject({ page: 3, limit: 10, total: 21, totalPages: 3 });
  });

  it('returns stage times, the restaurant name and an order summary', async () => {
    deliveries.findPageByDriverId.mockResolvedValue([[delivered('d-1', 'o-1')], 1]);

    const { items } = await service.getForDriver(AUTH, { page: 1, limit: 20 });

    expect(items).toEqual([
      {
        id: 'd-1',
        orderId: 'o-1',
        status: DeliveryStatus.DELIVERED,
        assignedAt: new Date('2026-10-07T10:00:00Z'),
        pickedUpAt: new Date('2026-10-07T10:10:00Z'),
        deliveredAt: new Date('2026-10-07T10:30:00Z'),
        cancelledAt: null,
        updatedAt: new Date('2026-10-07T10:30:00Z'),
        restaurant: { id: 'restaurant-1', name: 'QA Kitchen' },
        order: { items: [{ name: 'QA Burger', quantity: 2 }], totalAmount: '19.98', dropOffAddress: '1 Test Street, Apt 1' },
      },
    ]);
  });

  it('never exposes customer identity, notes or coordinates', async () => {
    deliveries.findPageByDriverId.mockResolvedValue([[delivered('d-1', 'o-1')], 1]);

    const { items } = await service.getForDriver(AUTH, { page: 1, limit: 20 });
    const json = JSON.stringify(items);

    expect(json).not.toContain('customer-1');
    expect(json).not.toContain('+201000000000');
    expect(json).not.toContain('30.04');
    expect(Object.keys(items[0].order!).sort()).toEqual(['dropOffAddress', 'items', 'totalAmount']);
  });

  it('looks each restaurant up once per page', async () => {
    deliveries.findPageByDriverId.mockResolvedValue([[delivered('d-1', 'o-1'), delivered('d-2', 'o-2')], 2]);

    await service.getForDriver(AUTH, { page: 1, limit: 20 });

    expect(restaurantClient.getRestaurant).toHaveBeenCalledTimes(1);
  });

  it('keeps a row when its order or restaurant cannot be loaded', async () => {
    deliveries.findPageByDriverId.mockResolvedValue([[delivered('d-1', 'o-1'), delivered('d-2', 'o-2')], 2]);
    orderClient.getOrder.mockImplementation(async (id: string) => {
      if (id === 'o-2') throw new Error('order-service down');
      return order(id);
    });
    restaurantClient.getRestaurant.mockRejectedValue(new Error('restaurant-service down'));

    const { items } = await service.getForDriver(AUTH, { page: 1, limit: 20 });

    expect(items.map((item) => item.id)).toEqual(['d-1', 'd-2']);
    expect(items[0]).toMatchObject({ restaurant: null, order: { totalAmount: '19.98' } });
    expect(items[1]).toMatchObject({ restaurant: null, order: null, deliveredAt: new Date('2026-10-07T10:30:00Z') });
  });
});
