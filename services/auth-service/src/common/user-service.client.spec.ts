import { SmsUnavailableError, UserServiceClient } from './user-service.client';
import { UnauthorizedError, signInternalRequest } from '@food-delivery/shared';

describe('UserServiceClient', () => {
  it('signs profile creation requests with the internal auth contract', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
    const client = new UserServiceClient({
      userServiceUrl: 'http://user-service:3002',
      internalAuthService: 'auth-service',
      internalAuthSecret: 'test-secret',
    } as any);
    const payload = {
      userId: 'user-1',
      email: 'user@example.com',
      fullName: 'Test User',
    };
    const expectedBody = {
      userId: 'user-1',
      authCredentialId: 'user-1',
      email: 'user@example.com',
      fullName: 'Test User',
    };

    await client.createProfile(payload, 'correlation-1');

    const [, request] = fetchMock.mock.calls[0];
    const headers = request.headers as Record<string, string>;
    expect(headers['x-internal-service']).toBe('auth-service');
    expect(JSON.parse(request.body)).toEqual(expectedBody);
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest({
        method: 'POST',
        path: '/internal/users',
        timestamp: headers['x-internal-timestamp'],
        nonce: headers['x-internal-nonce'],
        body: expectedBody,
        service: 'auth-service',
        secret: 'test-secret',
      }),
    );
  });
});
describe('UserServiceClient password reset calls (#35)', () => {
  const config = {
    userServiceUrl: 'http://user-service:3002',
    internalAuthService: 'auth-service',
    internalAuthSecret: 'test-secret',
  } as any;
  const phone = '+201012345678';

  function clientWith(response: { ok: boolean; status: number; json?: () => Promise<unknown> }) {
    const fetchMock = jest.fn().mockResolvedValue(response);
    global.fetch = fetchMock as any;
    return { client: new UserServiceClient(config), fetchMock };
  }

  it('signs the send request over the exact body and path it sends', async () => {
    const { client, fetchMock } = clientWith({ ok: true, status: 202 });

    await client.sendPasswordResetCode(phone, 'correlation-1');

    const [url, request] = fetchMock.mock.calls[0];
    const headers = request.headers as Record<string, string>;
    expect(url).toBe('http://user-service:3002/internal/users/password-reset/send');
    expect(JSON.parse(request.body)).toEqual({ phone });
    expect(headers['x-internal-service']).toBe('auth-service');
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest({
        method: 'POST',
        path: '/internal/users/password-reset/send',
        timestamp: headers['x-internal-timestamp'],
        nonce: headers['x-internal-nonce'],
        body: { phone },
        service: 'auth-service',
        secret: 'test-secret',
      }),
    );
  });

  it('signs the verify request and returns the user id', async () => {
    const { client, fetchMock } = clientWith({ ok: true, status: 200, json: async () => ({ userId: 'u1' }) });

    await expect(client.verifyPasswordResetCode(phone, '123456', 'correlation-1')).resolves.toEqual({ userId: 'u1' });

    const [url, request] = fetchMock.mock.calls[0];
    const headers = request.headers as Record<string, string>;
    expect(url).toBe('http://user-service:3002/internal/users/password-reset/verify');
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest({
        method: 'POST',
        path: '/internal/users/password-reset/verify',
        timestamp: headers['x-internal-timestamp'],
        nonce: headers['x-internal-nonce'],
        body: { phone, code: '123456' },
        service: 'auth-service',
        secret: 'test-secret',
      }),
    );
  });

  it('maps a 503 on send to SmsUnavailable and other failures to a plain error without the phone', async () => {
    await expect(clientWith({ ok: false, status: 503 }).client.sendPasswordResetCode(phone, 'c-1')).rejects.toBeInstanceOf(SmsUnavailableError);

    const failure = clientWith({ ok: false, status: 500 }).client.sendPasswordResetCode(phone, 'c-1');
    await expect(failure).rejects.toThrow('status 500');
    await expect(failure).rejects.not.toThrow(phone);
  });

  it('maps a 401 on verify to the generic 401', async () => {
    await expect(clientWith({ ok: false, status: 401 }).client.verifyPasswordResetCode(phone, '000000', 'c-1')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});
describe('UserServiceClient password reset calls (#35)', () => {
  const config = {
    userServiceUrl: 'http://user-service:3002',
    internalAuthService: 'auth-service',
    internalAuthSecret: 'test-secret',
  } as any;
  const phone = '+201012345678';

  function clientWith(response: { ok: boolean; status: number; json?: () => Promise<unknown> }) {
    const fetchMock = jest.fn().mockResolvedValue(response);
    global.fetch = fetchMock as any;
    return { client: new UserServiceClient(config), fetchMock };
  }

  it('signs the send request over the exact body and path it sends', async () => {
    const { client, fetchMock } = clientWith({ ok: true, status: 202 });

    await client.sendPasswordResetCode(phone, 'correlation-1');

    const [url, request] = fetchMock.mock.calls[0];
    const headers = request.headers as Record<string, string>;
    expect(url).toBe('http://user-service:3002/internal/users/password-reset/send');
    expect(JSON.parse(request.body)).toEqual({ phone });
    expect(headers['x-internal-service']).toBe('auth-service');
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest({
        method: 'POST',
        path: '/internal/users/password-reset/send',
        timestamp: headers['x-internal-timestamp'],
        nonce: headers['x-internal-nonce'],
        body: { phone },
        service: 'auth-service',
        secret: 'test-secret',
      }),
    );
  });

  it('signs the verify request and returns the user id', async () => {
    const { client, fetchMock } = clientWith({ ok: true, status: 200, json: async () => ({ userId: 'u1' }) });

    await expect(client.verifyPasswordResetCode(phone, '123456', 'correlation-1')).resolves.toEqual({ userId: 'u1' });

    const [url, request] = fetchMock.mock.calls[0];
    const headers = request.headers as Record<string, string>;
    expect(url).toBe('http://user-service:3002/internal/users/password-reset/verify');
    expect(headers['x-internal-signature']).toBe(
      signInternalRequest({
        method: 'POST',
        path: '/internal/users/password-reset/verify',
        timestamp: headers['x-internal-timestamp'],
        nonce: headers['x-internal-nonce'],
        body: { phone, code: '123456' },
        service: 'auth-service',
        secret: 'test-secret',
      }),
    );
  });

  it('maps a 503 on send to SmsUnavailable and other failures to a plain error without the phone', async () => {
    await expect(clientWith({ ok: false, status: 503 }).client.sendPasswordResetCode(phone, 'c-1')).rejects.toBeInstanceOf(SmsUnavailableError);

    const failure = clientWith({ ok: false, status: 500 }).client.sendPasswordResetCode(phone, 'c-1');
    await expect(failure).rejects.toThrow('status 500');
    await expect(failure).rejects.not.toThrow(phone);
  });

  it('maps a 401 on verify to the generic 401', async () => {
    await expect(clientWith({ ok: false, status: 401 }).client.verifyPasswordResetCode(phone, '000000', 'c-1')).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});