import { BadRequestError } from '@food-delivery/shared';
import { UserServiceClient } from './user-service.client';
import { AppConfig } from '../config/app-config';

describe('OrderService.UserServiceClient', () => {
  const client = new UserServiceClient({ userServiceUrl: 'http://user-service:3002' } as AppConfig);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("reads the caller's own profile with the caller's token", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'u1', address: '1 Main St' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(client.getOwnProfile('Bearer customer')).resolves.toMatchObject({ address: '1 Main St' });
    expect(fetchMock).toHaveBeenCalledWith('http://user-service:3002/users/me', {
      headers: { Authorization: 'Bearer customer' },
    });
  });

  it('fails clearly when user-service does not answer with the profile', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;

    await expect(client.getOwnProfile('Bearer customer')).rejects.toThrow(BadRequestError);
  });
});
