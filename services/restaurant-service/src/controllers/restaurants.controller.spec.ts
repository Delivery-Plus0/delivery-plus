import { Module, ValidationPipe } from '@nestjs/common';
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
  create: jest.fn(),
  listMine: jest.fn(),
  list: jest.fn(),
  getById: jest.fn(),
  update: jest.fn(),
  setDeliveryRadius: jest.fn(),
  submit: jest.fn(),
  getApplicationForStaff: jest.fn(),
  review: jest.fn(),
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
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter(silentLogger as any));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    jwt = app.get(JwtService);
  });

  beforeEach(() => {
    redis.set.mockReset().mockResolvedValue('OK');
    restaurantsService.assertOwnership.mockReset().mockResolvedValue(undefined);
    restaurantsService.create.mockReset().mockResolvedValue({ id: restaurantId });
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
    restaurantsService.setDeliveryRadius.mockReset().mockResolvedValue({
      id: restaurantId,
      deliveryRadiusKm: 8,
    });
    restaurantsService.submit.mockReset().mockResolvedValue({ id: restaurantId, approvalStatus: 'SUBMITTED' });
    restaurantsService.getApplicationForStaff.mockReset().mockResolvedValue({ id: restaurantId, reviews: [] });
    restaurantsService.review.mockReset().mockResolvedValue({ id: restaurantId, approvalStatus: 'APPROVED', reviews: [] });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  function ownerToken(sub: string, role: UserRole, perms?: string[]): string {
    return jwt.sign({ sub, email: `${sub}@example.com`, role, ...(perms ? { perms } : {}) });
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

  it('passes validated coordinates to the public restaurant list', async () => {
    const response = await fetch(`${baseUrl}/restaurants?lat=30.0444&lng=31.2357`);
    const partial = await fetch(`${baseUrl}/restaurants?lat=30.0444`);

    expect(response.status).toBe(200);
    expect(restaurantsService.list).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 30.0444, lng: 31.2357 }),
    );
    expect(partial.status).toBe(400);
  });

  it('rejects owner B updating owner A restaurant', async () => {
    const response = await fetch(`${baseUrl}/restaurants/${restaurantId}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + ownerToken(ownerB, UserRole.RESTAURANT_OWNER),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Stolen' }),
    });

    expect(response.status).toBe(403);
    expect(restaurantsService.update).toHaveBeenCalledWith(restaurantId, ownerB, { name: 'Stolen' });
  });

  it('creates a restaurant with its coordinate pair', async () => {
    const response = await fetch(`${baseUrl}/restaurants`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + ownerToken(ownerA, UserRole.RESTAURANT_OWNER),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Cairo Kitchen',
        address: '9 Nile Corniche',
        latitude: 30.0444,
        longitude: 31.2357,
      }),
    });

    expect(response.status).toBe(201);
    expect(restaurantsService.create).toHaveBeenCalledWith(ownerA, {
      name: 'Cairo Kitchen',
      address: '9 Nile Corniche',
      latitude: 30.0444,
      longitude: 31.2357,
    });
  });

  it('rejects a partial coordinate pair on create and update', async () => {
    const headers = {
      Authorization: 'Bearer ' + ownerToken(ownerA, UserRole.RESTAURANT_OWNER),
      'Content-Type': 'application/json',
    };
    const create = await fetch(`${baseUrl}/restaurants`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Cairo Kitchen',
        address: '9 Nile Corniche',
        latitude: 30.0444,
      }),
    });
    const update = await fetch(`${baseUrl}/restaurants/${restaurantId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ latitude: 30.0444 }),
    });

    expect(create.status).toBe(400);
    expect(update.status).toBe(400);
    expect(restaurantsService.create).not.toHaveBeenCalled();
    expect(restaurantsService.update).not.toHaveBeenCalled();
  });

  it('does not allow owners to set deliveryRadiusKm during restaurant creation', async () => {
    const response = await fetch(`${baseUrl}/restaurants`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + ownerToken(ownerA, UserRole.RESTAURANT_OWNER),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Cairo Kitchen',
        address: '9 Nile Corniche',
        deliveryRadiusKm: 9,
      }),
    });

    expect(response.status).toBe(400);
    expect(restaurantsService.create).not.toHaveBeenCalled();
  });

  it('allows only admins to change a restaurant delivery radius', async () => {
    const owner = await fetch(`${baseUrl}/restaurants/${restaurantId}/delivery-radius`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + ownerToken(ownerA, UserRole.RESTAURANT_OWNER),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deliveryRadiusKm: 8 }),
    });
    const customer = await fetch(`${baseUrl}/restaurants/${restaurantId}/delivery-radius`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + ownerToken(ownerA, UserRole.CUSTOMER),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deliveryRadiusKm: 8 }),
    });
    const admin = await fetch(`${baseUrl}/restaurants/${restaurantId}/delivery-radius`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + ownerToken(ownerA, UserRole.ADMIN),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deliveryRadiusKm: 8 }),
    });

    expect(owner.status).toBe(403);
    expect(customer.status).toBe(403);
    expect(admin.status).toBe(200);
    expect(restaurantsService.setDeliveryRadius).toHaveBeenCalledWith(restaurantId, 8);
  });

  it('validates delivery radius bounds before the admin update', async () => {
    const response = await fetch(`${baseUrl}/restaurants/${restaurantId}/delivery-radius`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + ownerToken(ownerA, UserRole.ADMIN),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ deliveryRadiusKm: 0 }),
    });

    expect(response.status).toBe(400);
    expect(restaurantsService.setDeliveryRadius).not.toHaveBeenCalled();
  });
  describe('restaurant applications (#208)', () => {
    const submittedAt = '2026-11-08T09:00:00.000Z';
    const call = (method: string, route: string, token?: string, body?: unknown) =>
      fetch(`${baseUrl}${route}`, {
        method,
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const reviewer = () => ownerToken(ownerB, UserRole.ADMIN, ['onboarding.review']);

    it('lets only the owner submit, as themself', async () => {
      expect((await call('POST', `/restaurants/${restaurantId}/submit`, ownerToken(ownerA, UserRole.RESTAURANT_OWNER))).status).toBe(200);
      expect(restaurantsService.submit).toHaveBeenCalledWith(restaurantId, ownerA);
      expect((await call('POST', `/restaurants/${restaurantId}/submit`, ownerToken(ownerA, UserRole.CUSTOMER))).status).toBe(403);
      expect((await call('POST', `/restaurants/${restaurantId}/submit`)).status).toBe(401);
    });

    it.each([
      ['no token', undefined, 401],
      ['the owner', () => ownerToken(ownerA, UserRole.RESTAURANT_OWNER, ['onboarding.review']), 403],
      ['staff without onboarding.review', () => ownerToken(ownerB, UserRole.ADMIN, ['support.read']), 403],
    ] as const)('refuses %s on the staff routes and decides nothing', async (_label, token, status) => {
      const bearer = typeof token === 'function' ? token() : token;
      expect((await call('GET', `/restaurants/${restaurantId}/application`, bearer)).status).toBe(status);
      expect((await call('POST', `/restaurants/${restaurantId}/review`, bearer, { decision: 'APPROVED', submittedAt })).status).toBe(status);
      expect(restaurantsService.review).not.toHaveBeenCalled();
      expect(restaurantsService.getApplicationForStaff).not.toHaveBeenCalled();
    });

    it('records a review with the reviewer from the token', async () => {
      const response = await call('POST', `/restaurants/${restaurantId}/review`, reviewer(), { decision: 'REJECTED', note: ' Logo missing ', submittedAt });
      expect(response.status).toBe(200);
      expect(restaurantsService.review).toHaveBeenCalledWith(ownerB, restaurantId, { decision: 'REJECTED', note: 'Logo missing', submittedAt });
    });

    it.each([
      ['a rejection without a note', { decision: 'REJECTED', submittedAt }],
      ['an unknown decision', { decision: 'VERIFIED', submittedAt }],
      ['no submittedAt', { decision: 'APPROVED' }],
    ])('refuses %s with 400', async (_label, body) => {
      expect((await call('POST', `/restaurants/${restaurantId}/review`, reviewer(), body)).status).toBe(400);
      expect(restaurantsService.review).not.toHaveBeenCalled();
    });

    it('normalizes the contact phone and refuses a number that is not an Egyptian mobile', async () => {
      const owner = ownerToken(ownerA, UserRole.RESTAURANT_OWNER);
      expect((await call('PATCH', `/restaurants/${restaurantId}`, owner, { contactPhone: '0101 234 5678', legalName: ' Kitchen LLC ' })).status).toBe(200);
      expect(restaurantsService.update).toHaveBeenCalledWith(restaurantId, ownerA, expect.objectContaining({ contactPhone: '+201012345678', legalName: 'Kitchen LLC' }));
      expect((await call('PATCH', `/restaurants/${restaurantId}`, owner, { contactPhone: '0223456789' })).status).toBe(400);
      expect((await call('PATCH', `/restaurants/${restaurantId}`, owner, { cuisineTags: ['a', 'b', 'c', 'd', 'e', 'f'].map((tag) => tag.repeat(3)) })).status).toBe(400);
    });
  });
});
