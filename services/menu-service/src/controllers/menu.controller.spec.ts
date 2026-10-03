import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AllExceptionsFilter, ForbiddenError, UserRole } from '@food-delivery/shared';
import { MenuService } from '../services/menu.service';
import { MenuController } from './menu.controller';

const itemId = '55555555-5555-41d4-a716-446655440000';
const foreignItemId = '66666666-6666-41d4-a716-446655440000';
const ownerA = '11111111-1111-41d4-a716-446655440000';
const ownerB = '22222222-2222-41d4-a716-446655440000';
const jwtSecret = 'test-jwt-secret';
const silentLogger = { log: jest.fn() };
const menuService = {
  getMenu: jest.fn(),
  updateAvailability: jest.fn(),
};

@Module({
  imports: [JwtModule.register({ secret: jwtSecret })],
  controllers: [MenuController],
  providers: [{ provide: MenuService, useValue: menuService }],
})
class MenuControllerTestModule {}

describe('MenuController ownership HTTP boundaries', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let jwt: JwtService;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(MenuControllerTestModule, {
      logger: false,
      abortOnError: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter(silentLogger as any));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    jwt = app.get(JwtService);
  });

  beforeEach(() => {
    menuService.getMenu.mockReset().mockResolvedValue({ restaurantId: 'r1', items: [] });
    menuService.updateAvailability.mockReset().mockImplementation(async (id, requesterId) => {
      if (requesterId !== ownerA || id !== itemId) {
        throw new ForbiddenError('You do not own this restaurant');
      }
      return { id, available: false };
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

  it('keeps public menu reads available without restaurant-owner access', async () => {
    const response = await fetch(`${baseUrl}/restaurants/r1/menu`);

    expect(response.status).toBe(200);
    expect(menuService.getMenu).toHaveBeenCalledWith('r1');
  });

  it('lets owner A update availability on their item', async () => {
    const response = await fetch(`${baseUrl}/menu-items/${itemId}/availability`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token(ownerA, UserRole.RESTAURANT_OWNER)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ available: false }),
    });

    expect(response.status).toBe(200);
    expect(menuService.updateAvailability).toHaveBeenCalledWith(itemId, ownerA, { available: false });
  });

  it('rejects owner B updating owner A menu item availability', async () => {
    const response = await fetch(`${baseUrl}/menu-items/${itemId}/availability`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token(ownerB, UserRole.RESTAURANT_OWNER)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ available: false }),
    });

    expect(response.status).toBe(403);
  });

  it('rejects a tampered menu item id', async () => {
    const response = await fetch(`${baseUrl}/menu-items/${foreignItemId}/availability`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token(ownerA, UserRole.RESTAURANT_OWNER)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ available: false }),
    });

    expect(response.status).toBe(403);
  });

  it('rejects a customer mutating menu item availability', async () => {
    const response = await fetch(`${baseUrl}/menu-items/${itemId}/availability`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token(ownerA, UserRole.CUSTOMER)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ available: false }),
    });

    expect(response.status).toBe(403);
    expect(menuService.updateAvailability).not.toHaveBeenCalled();
  });
});
