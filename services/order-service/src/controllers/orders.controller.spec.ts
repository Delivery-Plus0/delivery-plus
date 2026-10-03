import { Module } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import {
  AllExceptionsFilter,
  ForbiddenError,
  RateLimitGuard,
  RateLimiterService,
  UserRole,
} from '@food-delivery/shared';
import { OrdersService } from '../services/orders.service';
import { OrdersController } from './orders.controller';

const restaurantId = '550e8400-e29b-41d4-a716-446655440000';
const foreignRestaurantId = '550e8400-e29b-41d4-a716-446655440001';
const orderId = '33333333-3333-41d4-a716-446655440000';
const ownerA = '11111111-1111-41d4-a716-446655440000';
const ownerB = '22222222-2222-41d4-a716-446655440000';
const customerId = '44444444-4444-41d4-a716-446655440000';
const jwtSecret = 'test-jwt-secret';
const silentLogger = { log: jest.fn() };
const ordersService = {
  listByRestaurant: jest.fn(),
  listByCustomer: jest.fn(),
  getById: jest.fn(),
  updateStatus: jest.fn(),
};

@Module({
  imports: [JwtModule.register({ secret: jwtSecret })],
  controllers: [OrdersController],
  providers: [
    { provide: OrdersService, useValue: ordersService },
    RateLimitGuard,
    Reflector,
    {
      provide: RateLimiterService,
      useValue: { incrementAndCheck: jest.fn().mockResolvedValue(true) },
    },
  ],
})
class OrdersControllerTestModule {}

describe('OrdersController restaurant HTTP boundaries', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let jwt: JwtService;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(OrdersControllerTestModule, {
      logger: false,
      abortOnError: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter(silentLogger as any));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    jwt = app.get(JwtService);
  });

  beforeEach(() => {
    ordersService.listByRestaurant.mockReset().mockImplementation(async (id, requesterId) => {
      if (requesterId !== ownerA || id !== restaurantId) {
        throw new ForbiddenError('You do not own this restaurant');
      }
      return { items: [{ id: orderId }], page: 1, limit: 20, total: 1, totalPages: 1 };
    });
    ordersService.listByCustomer.mockReset().mockResolvedValue({
      items: [{ id: orderId, customerId }],
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
    ordersService.getById.mockReset().mockImplementation(async (_id, requesterId, role) => {
      if (role === UserRole.CUSTOMER && requesterId === customerId) {
        return { id: orderId, customerId };
      }
      if (role === UserRole.RESTAURANT_OWNER && requesterId === ownerA) {
        return { id: orderId, restaurantId };
      }
      throw new ForbiddenError('You do not have access to this order');
    });
    ordersService.updateStatus.mockReset().mockImplementation(async (_id, requesterId) => {
      if (requesterId !== ownerA) {
        throw new ForbiddenError('You do not own this restaurant');
      }
      return { id: orderId, status: 'PREPARING' };
    });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  function token(sub: string, role: UserRole): string {
    return jwt.sign({ sub, email: `${sub}@example.com`, role });
  }

  it('lets a customer list their own orders without restaurant-owner access', async () => {
    const response = await fetch(`${baseUrl}/orders`, {
      headers: { Authorization: `Bearer ${token(customerId, UserRole.CUSTOMER)}` },
    });

    expect(response.status).toBe(200);
    expect(ordersService.listByCustomer).toHaveBeenCalledWith(customerId, undefined, undefined);
  });

  it('rejects a customer listing restaurant orders', async () => {
    const response = await fetch(`${baseUrl}/orders/restaurant/${restaurantId}`, {
      headers: { Authorization: `Bearer ${token(customerId, UserRole.CUSTOMER)}` },
    });

    expect(response.status).toBe(403);
    expect(ordersService.listByRestaurant).not.toHaveBeenCalled();
  });

  it('lets owner A list their restaurant orders', async () => {
    const response = await fetch(`${baseUrl}/orders/restaurant/${restaurantId}`, {
      headers: { Authorization: `Bearer ${token(ownerA, UserRole.RESTAURANT_OWNER)}` },
    });

    expect(response.status).toBe(200);
    expect(ordersService.listByRestaurant).toHaveBeenCalledWith(restaurantId, ownerA, undefined, undefined);
  });

  it('rejects owner B listing owner A restaurant orders', async () => {
    const response = await fetch(`${baseUrl}/orders/restaurant/${restaurantId}`, {
      headers: { Authorization: `Bearer ${token(ownerB, UserRole.RESTAURANT_OWNER)}` },
    });

    expect(response.status).toBe(403);
  });

  it('rejects owner B reading owner A order', async () => {
    const response = await fetch(`${baseUrl}/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${token(ownerB, UserRole.RESTAURANT_OWNER)}` },
    });

    expect(response.status).toBe(403);
  });

  it('rejects owner B transitioning owner A order', async () => {
    const response = await fetch(`${baseUrl}/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token(ownerB, UserRole.RESTAURANT_OWNER)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'PREPARING' }),
    });

    expect(response.status).toBe(403);
  });

  it('rejects a tampered restaurant id on the owner order list', async () => {
    const response = await fetch(`${baseUrl}/orders/restaurant/${foreignRestaurantId}`, {
      headers: { Authorization: `Bearer ${token(ownerA, UserRole.RESTAURANT_OWNER)}` },
    });

    expect(response.status).toBe(403);
  });
});
