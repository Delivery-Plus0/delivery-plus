import { BadRequestError } from '@food-delivery/shared';
import { RestaurantServiceClient } from './restaurant-service.client';

describe('MenuService.RestaurantServiceClient', () => {
  const restaurantId = '550e8400-e29b-41d4-a716-446655440000';
  const requesterId = '11111111-1111-41d4-a716-446655440000';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('checks ownership using valid UUID v4 ids and signed internal auth', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    const client = new RestaurantServiceClient({
      restaurantServiceUrl: 'http://restaurant-service:3003',
      internalAuthService: 'menu-service',
      internalAuthSecret: 'test-secret',
    } as any);

    await expect(client.assertOwnership(restaurantId, requesterId)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      `http://restaurant-service:3003/restaurants/${restaurantId}/ownership/${requesterId}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-internal-service': 'menu-service',
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
      internalAuthService: 'menu-service',
      internalAuthSecret: 'test-secret',
    } as any);
    const promise = client.assertOwnership('http://evil.example', requesterId);

    await expect(promise).rejects.toThrow(BadRequestError);
    await expect(promise).rejects.toThrow('restaurantId must be a valid UUID v4');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
