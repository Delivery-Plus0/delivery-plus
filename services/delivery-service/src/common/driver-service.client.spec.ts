import { BadRequestError } from '@food-delivery/shared';
import { DriverServiceClient } from './driver-service.client';

describe('DeliveryServiceClient.DriverServiceClient', () => {
  const validDriverId = '550e8400-e29b-41d4-a716-446655440000';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches a driver with a valid UUID v4 driver id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: validDriverId, userId: '11111111-1111-41d4-a716-446655440000', status: 'available' }),
    });
    global.fetch = fetchMock as any;

    const client = new DriverServiceClient({ driverServiceUrl: 'http://driver-service:3009' } as any, {
      mint: async () => 'token',
    } as any);

    await expect(client.getDriver(validDriverId)).resolves.toMatchObject({ id: validDriverId });
    // Driver profiles are no longer public: the service authenticates with its system token.
    expect(fetchMock).toHaveBeenCalledWith(`http://driver-service:3009/drivers/${validDriverId}`, {
      headers: { Authorization: 'token' },
    });
  });

  it('rejects malformed driverId before making the request', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const client = new DriverServiceClient({ driverServiceUrl: 'http://driver-service:3009' } as any, {
      mint: async () => 'token',
    } as any);
    const promise = client.getDriver('http://evil.example');

    await expect(promise).rejects.toThrow(BadRequestError);
    await expect(promise).rejects.toThrow('driverId must be a valid UUID v4');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists available drivers with the system token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [] }) });
    global.fetch = fetchMock as any;
    const client = new DriverServiceClient({ driverServiceUrl: 'http://driver-service:3009' } as any, {
      mint: async () => 'Bearer system',
    } as any);

    await expect(client.findAvailableDriver()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('http://driver-service:3009/drivers/available?page=1&limit=1', {
      headers: { Authorization: 'Bearer system' },
    });
  });

  describe('releaseDriver (idempotent)', () => {
    const client = () =>
      new DriverServiceClient({ driverServiceUrl: 'http://driver-service:3009' } as any, {
        mint: async () => 'Bearer system',
      } as any);
    const response = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => body });

    it('sets a BUSY driver AVAILABLE', async () => {
      const fetchMock = jest.fn().mockResolvedValue(response(200, {}));
      global.fetch = fetchMock as any;

      await expect(client().releaseDriver(validDriverId)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(`http://driver-service:3009/drivers/${validDriverId}/status`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer system', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'AVAILABLE' }),
      });
    });

    it('treats an already-released driver as done (a retry after a later step failed)', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(response(409))
        .mockResolvedValueOnce(response(200, { id: validDriverId, status: 'AVAILABLE' }));
      global.fetch = fetchMock as any;

      await expect(client().releaseDriver(validDriverId)).resolves.toBeUndefined();
    });

    it('treats an OFFLINE or SUSPENDED driver as nothing to release', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(response(409))
        .mockResolvedValueOnce(response(200, { id: validDriverId, status: 'SUSPENDED' })) as any;

      await expect(client().releaseDriver(validDriverId)).resolves.toBeUndefined();
    });

    it('still fails when the driver is BUSY and driver-service refuses', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(response(409))
        .mockResolvedValueOnce(response(200, { id: validDriverId, status: 'BUSY' })) as any;

      await expect(client().releaseDriver(validDriverId)).rejects.toThrow('cannot move to AVAILABLE');
    });

    it('fails (so the caller errors and can be retried) when driver-service is down', async () => {
      const fetchMock = jest.fn().mockResolvedValue(response(503));
      global.fetch = fetchMock as any;

      await expect(client().releaseDriver(validDriverId)).rejects.toThrow('status 503');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
