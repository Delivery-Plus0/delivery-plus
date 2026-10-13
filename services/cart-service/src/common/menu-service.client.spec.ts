import { BadRequestError } from '@food-delivery/shared';
import { MenuServiceClient } from './menu-service.client';

describe('MenuServiceClient', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches a menu item using a valid UUID v4 id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: validId,
        restaurantId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        name: 'Burger',
        price: '9.99',
        available: true,
      }),
    });
    global.fetch = fetchMock as any;

    const client = new MenuServiceClient({ menuServiceUrl: 'http://menu-service:3004' } as any);

    await expect(client.getItem(validId)).resolves.toEqual({
      id: validId,
      restaurantId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      name: 'Burger',
      price: 9.99,
      available: true,
      archived: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(`http://menu-service:3004/menu-items/${validId}`);
  });

  it('rejects malformed menuItemId before making the request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const client = new MenuServiceClient({ menuServiceUrl: 'http://menu-service:3004' } as any);
    const promise = client.getItem('http://evil.example');

    await expect(promise).rejects.toThrow(BadRequestError);
    await expect(promise).rejects.toThrow('menuItemId must be a valid UUID v4');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
