import { BadRequestError, ForbiddenError, NotFoundError } from '@food-delivery/shared';
import { OrderServiceClient } from './order-service.client';

describe('DeliveryServiceClient.OrderServiceClient', () => {
  const validOrderId = '550e8400-e29b-41d4-a716-446655440000';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches an order with a valid UUID v4 order id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: validOrderId, customerId: '11111111-1111-41d4-a716-446655440000', restaurantId: '22222222-2222-41d4-a716-446655440000', status: 'confirmed' }),
    });
    global.fetch = fetchMock as any;

    const client = new OrderServiceClient({ orderServiceUrl: 'http://order-service:3006' } as any, {
      mint: async () => 'token',
    } as any);

    await expect(client.getOrder(validOrderId)).resolves.toMatchObject({ id: validOrderId });
    expect(fetchMock).toHaveBeenCalledWith(`http://order-service:3006/orders/${validOrderId}`, {
      headers: { Authorization: 'token' },
    });
  });

  it('rejects malformed orderId before making the request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const client = new OrderServiceClient({ orderServiceUrl: 'http://order-service:3006' } as any, {
      mint: async () => 'token',
    } as any);
    const promise = client.getOrder('http://evil.example');

    await expect(promise).rejects.toThrow(BadRequestError);
    await expect(promise).rejects.toThrow('orderId must be a valid UUID v4');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('assertReadableBy', () => {
    const client = new OrderServiceClient({ orderServiceUrl: 'http://order-service:3006' } as any, {
      mint: async () => 'Bearer system',
    } as any);

    it("asks order-service with the requester's own token", async () => {
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock as any;

      await client.assertReadableBy(validOrderId, 'Bearer customer');

      expect(fetchMock).toHaveBeenCalledWith(`http://order-service:3006/orders/${validOrderId}`, {
        headers: { Authorization: 'Bearer customer' },
      });
    });

    it.each([
      [404, NotFoundError],
      [403, ForbiddenError],
      [401, ForbiddenError],
    ])('maps order-service %s to %p', async (status, errorType) => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status }) as any;
      await expect(client.assertReadableBy(validOrderId, 'Bearer customer')).rejects.toThrow(errorType);
    });
  });
});
