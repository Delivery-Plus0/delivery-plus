import { BadRequestError, NotFoundError } from '@food-delivery/shared';
import { RestaurantServiceClient } from './restaurant-service.client';
import { AppConfig } from '../config/app-config';

describe('DeliveryService.RestaurantServiceClient', () => {
  const restaurantId = '550e8400-e29b-41d4-a716-446655440000';
  const client = new RestaurantServiceClient({ restaurantServiceUrl: 'http://restaurant-service:3003' } as AppConfig);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads the public restaurant profile', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: restaurantId, name: 'Burger Palace', address: '123 Main St' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(client.getRestaurant(restaurantId)).resolves.toMatchObject({ name: 'Burger Palace', address: '123 Main St' });
    expect(fetchMock).toHaveBeenCalledWith(`http://restaurant-service:3003/restaurants/${restaurantId}`);
  });

  it('rejects a malformed id before making the request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(client.getRestaurant('../admin')).rejects.toThrow(BadRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 404 to NotFoundError', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;
    await expect(client.getRestaurant(restaurantId)).rejects.toThrow(NotFoundError);
  });
});
