import { DeliveryStatus } from '@food-delivery/shared';
import { DeliveryContactService } from './delivery-contact.service';

describe('DeliveryContactService (#211)', () => {
  let users: { getProfile: jest.Mock };
  let restaurants: { getContact: jest.Mock };
  let drivers: { getDriver: jest.Mock };
  let reveals: { record: jest.Mock };
  let service: DeliveryContactService;
  const parties = { customerId: 'customer-1', restaurantId: 'restaurant-1' };

  beforeEach(() => {
    users = {
      getProfile: jest.fn(async (id: string) => ({ id, fullName: 'X', phone: id === 'customer-1' ? '+201000000001' : '+201000000003' })),
    };
    restaurants = { getContact: jest.fn().mockResolvedValue({ id: 'restaurant-1', contactPhone: '+201000000002' }) };
    drivers = { getDriver: jest.fn().mockResolvedValue({ id: 'driver-1', userId: 'driver-user-1' }) };
    reveals = { record: jest.fn().mockResolvedValue(undefined) };
    service = new DeliveryContactService(users as never, restaurants as never, drivers as never, reveals as never);
  });

  it.each([DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.PICKED_UP, DeliveryStatus.IN_TRANSIT])(
    'gives the driver the customer and restaurant phones while %s, and records the reveal',
    async (status) => {
      await expect(service.forDriver({ id: 'delivery-1', status }, parties, 'driver-user-1')).resolves.toEqual({
        customerPhone: '+201000000001',
        restaurantPhone: '+201000000002',
      });
      expect(reveals.record).toHaveBeenCalledWith('delivery-1', 'driver-user-1', 'DRIVER', ['customerPhone', 'restaurantPhone']);
    },
  );

  it.each([DeliveryStatus.CREATED, DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED])('reveals nothing while %s', async (status) => {
    await expect(service.forDriver({ id: 'delivery-1', status }, parties, 'driver-user-1')).resolves.toEqual({ customerPhone: null, restaurantPhone: null });
    await expect(service.forCustomer({ id: 'delivery-1', status, driverId: 'driver-1' }, 'customer-1')).resolves.toBeNull();
    expect(users.getProfile).not.toHaveBeenCalled();
    expect(restaurants.getContact).not.toHaveBeenCalled();
    expect(reveals.record).not.toHaveBeenCalled();
  });

  it("gives the customer the assigned driver's phone and records it", async () => {
    await expect(service.forCustomer({ id: 'delivery-1', status: DeliveryStatus.IN_TRANSIT, driverId: 'driver-1' }, 'customer-1')).resolves.toBe('+201000000003');
    expect(users.getProfile).toHaveBeenCalledWith('driver-user-1');
    expect(reveals.record).toHaveBeenCalledWith('delivery-1', 'customer-1', 'CUSTOMER', ['driverPhone']);
  });

  it('returns null for a number that cannot be read, without failing, and records only what was shown', async () => {
    restaurants.getContact.mockRejectedValue(new Error('restaurant-service down'));
    await expect(service.forDriver({ id: 'delivery-1', status: DeliveryStatus.PICKED_UP }, parties, 'driver-user-1')).resolves.toEqual({
      customerPhone: '+201000000001',
      restaurantPhone: null,
    });
    expect(reveals.record).toHaveBeenCalledWith('delivery-1', 'driver-user-1', 'DRIVER', ['customerPhone']);
  });

  it('shows no number when the reveal cannot be recorded', async () => {
    reveals.record.mockRejectedValue(new Error('db down'));
    await expect(service.forDriver({ id: 'delivery-1', status: DeliveryStatus.PICKED_UP }, parties, 'driver-user-1')).resolves.toEqual({
      customerPhone: null,
      restaurantPhone: null,
    });
    await expect(service.forCustomer({ id: 'delivery-1', status: DeliveryStatus.PICKED_UP, driverId: 'driver-1' }, 'customer-1')).resolves.toBeNull();
  });

  it('has no driver phone before a driver is assigned', async () => {
    await expect(service.forCustomer({ id: 'delivery-1', status: DeliveryStatus.DRIVER_ASSIGNED, driverId: null }, 'customer-1')).resolves.toBeNull();
  });
});
