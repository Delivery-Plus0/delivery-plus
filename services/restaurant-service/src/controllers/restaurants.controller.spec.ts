import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import {
  AllExceptionsFilter,
  ForbiddenError,
  INTERNAL_AUTH_HEADERS,
  signInternalRequest,
  UserRole,
} from '@food-delivery/shared';
import { APP_CONFIG } from '../config/app-config';
import { InternalAuthGuard } from '../guards/internal-auth.guard';
import { RestaurantsService } from '../services/restaurants.service';
import { RestaurantsController } from './restaurants.controller';

const restaurantId = '550e8400-e29b-41d4-a716-446655440000';
const foreignRestaurantId = '550e8400-e29b-41d4-a716-446655440001';
const ownerA = '11111111-1111-41d4-a716-446655440000';
const ownerB = '22222222-2222-41d4-a716-446655440000';
const path = `/restaurants/${restaurantId}/ownership/${ownerA}`;
const jwtSecret = 'test-jwt-secret';
const config = {
  jwtSecret,
  internalAuthSecret: 'test-internal-secret',
  internalAuthAllowedServices: ['menu-service', 'order-service'],
};
const redis = { set: jest.fn() };
const restaurantsService = {
  assertOwnership: jest.fn(),
  listMine: jest.fn(),
  list: jest.fn(),
  getById: jest.fn(),
  update: jest.fn(),
};
const silentLogger = { log: jest.fn() };

@Module({
  imports: [JwtModule.register({ secret: jwtSecret })],
  controllers: [RestaurantsController],
  providers: [
    InternalAuthGuard,
    { provide: APP_CONFIG, useValue: config },
    { provide: 'REDIS_CLIENT', useValue: redis },
    { provide: RestaurantsService, useValue: restaurantsService },
  ],
})
class RestaurantsControllerTestModule {}

describe('RestaurantsController HTTP boundaries', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let jwt: JwtService;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(RestaurantsControllerTestModule, {
      logger: false,
      abortOnError: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter(silentLogger as any));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    jwt = app.get(JwtService);
  });

  beforeEach(() => {
    redis.set.mockReset().mockResolvedValue('OK');
    restaurantsService.assertOwnership.mockReset().mockResolvedValue(undefined);
    restaurantsService.listMine.mockReset().mockResolvedValue([
      { id: restaurantId, name: 'Own Place', address: '1 Main', status: 'OPEN' },
    ]);
    restaurantsService.list.mockReset().mockResolvedValue({
      items: [{ id: restaurantId, name: 'Pizza Place', address: '123 Main St', status: 'OPEN' }],
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
    restaurantsService.getById.mockReset().mockResolvedValue({
      id: restaurantId,
      name: 'Pizza Place',
      address: '123 Main St',
      status: 'OPEN',
    });
    restaurantsService.update.mockReset().mockImplementation(async (_id, requesterId) => {
      if (requesterId !== ownerA) {
        throw new ForbiddenError('You do not own this restaurant');
      }
      return { id: restaurantId, name: 'Updated' };
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  function ownerToken(sub: string, role: UserRole): string {
    return jwt.sign({ sub, email: `${sub}@example.com`, role });
  }

  async function signedOwnershipFetch(
    service: string,
    overrides: { path?: string; timestamp?: string; nonce?: string; signature?: string } = {},
  ) {
    const requestPath = overrides.path ?? path;
    const timestamp = overrides.timestamp ?? Math.floor(Date.now() / 1000).toString();
    const nonce = overrides.nonce ?? `nonce-${Math.random()}`;
    const signature =
      overrides.signature ??
      signInternalRequest({
        method: 'GET',
        path: requestPath,
        timestamp,
        nonce,
        body: {},
        service,
        secret: config.internalAuthSecret,
      });
    return fetch(`${baseUrl}${requestPath}`, {
      headers: {
        [INTERNAL_AUTH_HEADERS.service]: service,
        [INTERNAL_AUTH_HEADERS.timestamp]: timestamp,
        [INTERNAL_AUTH_HEADERS.nonce]: nonce,
        [INTERNAL_AUTH_HEADERS.signature]: signature,
      },
    });
  }

  it('rejects a public ownership request before checking ownership', async () => {
    const response = await fetch(`${baseUrl}${path}`);

    expect(response.status).toBe(401);
    expect(restaurantsService.assertOwnership).not.toHaveBeenCalled();
  });

  it('rejects an invalid HMAC signature', async () => {
    const response = await signedOwnershipFetch('menu-service', {
      signature: 'a'.repeat(64),
    });

    expect(response.status).toBe(401);
    expect(restaurantsService.assertOwnership).not.toHaveBeenCalled();
  });

  it('rejects an expired timestamp', async () => {
    const response = await signedOwnershipFetch('menu-service', {
      timestamp: (Math.floor(Date.now() / 1000) - 301).toString(),
    });

    expect(response.status).toBe(401);
    expect(restaurantsService.assertOwnership).not.toHaveBeenCalled();
  });

  it('rejects an untrusted internal service identity', async () => {
    const response = await signedOwnershipFetch('billing-service');

    expect(response.status).toBe(401);
    expect(restaurantsService.assertOwnership).not.toHaveBeenCalled();
  });

  it('rejects a replayed nonce', async () => {
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    const nonce = 'replay-nonce';

    const first = await signedOwnershipFetch('menu-service', { nonce });
    const second = await signedOwnershipFetch('menu-service', { nonce });

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
  });

  it('rejects a restaurant id changed after signing', async () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = 'tampered-id';
    const signature = signInternalRequest({
      method: 'GET',
      path,
      timestamp,
      nonce,
      body: {},
      service: 'menu-service',
      secret: config.internalAuthSecret,
    });
    const response = await fetch(`${baseUrl}/restaurants/${foreignRestaurantId}/ownership/${ownerA}`, {
      headers: {
        [INTERNAL_AUTH_HEADERS.service]: 'menu-service',
        [INTERNAL_AUTH_HEADERS.timestamp]: timestamp,
        [INTERNAL_AUTH_HEADERS.nonce]: nonce,
        [INTERNAL_AUTH_HEADERS.signature]: signature,
      },
    });

    expect(response.status).toBe(401);
    expect(restaurantsService.assertOwnership).not.toHaveBeenCalled();
  });

  it('accepts a signed request from menu-service', async () => {
    const response = await signedOwnershipFetch('menu-service');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ owned: true });
    expect(restaurantsService.assertOwnership).toHaveBeenCalledWith(restaurantId, ownerA);
  });

  it('accepts a signed request from order-service', async () => {
    const response = await signedOwnershipFetch('order-service');

    expect(response.status).toBe(200);
    expect(restaurantsService.assertOwnership).toHaveBeenCalledWith(restaurantId, ownerA);
  });

  it('lists only the authenticated owner restaurants from JWT subject', async () => {
    const response = await fetch(`${baseUrl}/restaurants/me`, {
      headers: { Authorization: `Bearer ${ownerToken(ownerA, UserRole.RESTAURANT_OWNER)}` },
    });

    expect(response.status).toBe(200);
    expect(restaurantsService.listMine).toHaveBeenCalledWith(ownerA);
  });

  it('rejects GET /restaurants/me without a JWT', async () => {
    const response = await fetch(`${baseUrl}/restaurants/me`);

    expect(response.status).toBe(401);
    expect(restaurantsService.listMine).not.toHaveBeenCalled();
  });

  it('rejects GET /restaurants/me for a customer', async () => {
    const response = await fetch(`${baseUrl}/restaurants/me`, {
      headers: { Authorization: `Bearer ${ownerToken(ownerA, UserRole.CUSTOMER)}` },
    });

    expect(response.status).toBe(403);
    expect(restaurantsService.listMine).not.toHaveBeenCalled();
  });

  it('keeps public restaurant list and detail free of ownerId', async () => {
    const list = await fetch(`${baseUrl}/restaurants`);
    const detail = await fetch(`${baseUrl}/restaurants/${restaurantId}`);
    const listed = await list.json();
    const restaurant = await detail.json();

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(listed)).not.toContain('ownerId');
    expect(restaurant).not.toHaveProperty('ownerId');
  });

  it('rejects owner B updating owner A restaurant', async () => {
    const response = await fetch(`${baseUrl}/restaurants/${restaurantId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ownerToken(ownerB, UserRole.RESTAURANT_OWNER)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Stolen' }),
    });

    expect(response.status).toBe(403);
    expect(restaurantsService.update).toHaveBeenCalledWith(restaurantId, ownerB, { name: 'Stolen' });
  });
});
