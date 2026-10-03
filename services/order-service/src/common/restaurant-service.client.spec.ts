import { BadRequestError } from '@food-delivery/shared';
import { RestaurantServiceClient } from './restaurant-service.client';

describe('OrderService.RestaurantServiceClient', () => {
  const validRestaurantId = '550e8400-e29b-41d4-a716-446655440000';
  const validRequesterId = '11111111-1111-41d4-a716-446655440000';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('requests a restaurant using a valid UUID v4 id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: validRestaurantId, ownerId: validRequesterId, name: 'Café', status: 'open' }),
    });
    global.fetch = fetchMock as any;

    const client = new RestaurantServiceClient({
      restaurantServiceUrl: 'http://restaurant-service:3003',
      internalAuthService: 'order-service',
      internalAuthSecret: 'test-secret',
    } as any);

    await expect(client.getRestaurant(validRestaurantId)).resolves.toMatchObject({ id: validRestaurantId });
    expect(fetchMock).toHaveBeenCalledWith(`http://restaurant-service:3003/restaurants/${validRestaurantId}`);
  });

  it('signs ownership checks with internal auth', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    const client = new RestaurantServiceClient({
      restaurantServiceUrl: 'http://restaurant-service:3003',
      internalAuthService: 'order-service',
      internalAuthSecret: 'test-secret',
    } as any);

    await expect(client.assertOwnership(validRestaurantId, validRequesterId)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `http://restaurant-service:3003/restaurants/${validRestaurantId}/ownership/${validRequesterId}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-internal-service': 'order-service',
          'x-internal-timestamp': expect.any(String),
          'x-internal-nonce': expect.any(String),
          'x-internal-signature': expect.any(String),
        }),
      }),
    );
  });

  it('rejects malformed ids before making the request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const client = new RestaurantServiceClient({
      restaurantServiceUrl: 'http://restaurant-service:3003',
      internalAuthService: 'order-service',
      internalAuthSecret: 'test-secret',
    } as any);
    const promise = client.getRestaurant('http://evil.example');

    await expect(promise).rejects.toThrow(BadRequestError);
    await expect(promise).rejects.toThrow('restaurantId must be a valid UUID v4');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
