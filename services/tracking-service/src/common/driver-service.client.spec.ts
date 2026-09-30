import { BadRequestError } from '@food-delivery/shared';
import { DriverServiceClient } from './driver-service.client';

describe('TrackingService.DriverServiceClient', () => {
  const validDriverId = '550e8400-e29b-41d4-a716-446655440000';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches a driver using a valid UUID v4 id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: validDriverId, userId: '11111111-1111-41d4-a716-446655440000' }),
    });
    global.fetch = fetchMock as any;

    const client = new DriverServiceClient({ driverServiceUrl: 'http://driver-service:3009' } as any, {
      mint: async () => 'Bearer system',
    } as any);

    await expect(client.getDriver(validDriverId)).resolves.toMatchObject({ id: validDriverId });
    expect(fetchMock).toHaveBeenCalledWith(`http://driver-service:3009/drivers/${validDriverId}`, {
      headers: { Authorization: 'Bearer system' },
    });
  });

  it('rejects malformed driverId before making the request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const client = new DriverServiceClient({ driverServiceUrl: 'http://driver-service:3009' } as any, {
      mint: async () => 'Bearer system',
    } as any);
    const promise = client.getDriver('http://evil.example');

    await expect(promise).rejects.toThrow(BadRequestError);
    await expect(promise).rejects.toThrow('driverId must be a valid UUID v4');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
