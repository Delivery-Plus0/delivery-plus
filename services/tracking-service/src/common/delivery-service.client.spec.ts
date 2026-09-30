import { BadRequestError, ForbiddenError } from '@food-delivery/shared';
import { DeliveryServiceClient } from './delivery-service.client';

describe('TrackingService.DeliveryServiceClient', () => {
  const validDeliveryId = '550e8400-e29b-41d4-a716-446655440000';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches a delivery using a valid UUID v4 id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: validDeliveryId,
        orderId: '11111111-1111-41d4-a716-446655440000',
        driverId: '22222222-2222-41d4-a716-446655440000',
        status: 'confirmed',
      }),
    });
    global.fetch = fetchMock as any;

    const client = new DeliveryServiceClient({ deliveryServiceUrl: 'http://delivery-service:3008' } as any);

    await expect(client.getDelivery(validDeliveryId, 'Bearer test')).resolves.toMatchObject({ id: validDeliveryId });
    expect(fetchMock).toHaveBeenCalledWith(`http://delivery-service:3008/deliveries/${validDeliveryId}`, {
      headers: { Authorization: 'Bearer test' },
    });
  });

  it('rejects malformed deliveryId before making the request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const client = new DeliveryServiceClient({ deliveryServiceUrl: 'http://delivery-service:3008' } as any);
    const promise = client.getDelivery('http://evil.example', 'Bearer test');

    await expect(promise).rejects.toThrow(BadRequestError);
    await expect(promise).rejects.toThrow('deliveryId must be a valid UUID v4');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces delivery-service's ownership rejection as 403, not a generic 400", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 }) as any;
    const client = new DeliveryServiceClient({ deliveryServiceUrl: 'http://delivery-service:3008' } as any);

    await expect(client.getDelivery(validDeliveryId, 'Bearer other-customer')).rejects.toThrow(ForbiddenError);
  });
});
