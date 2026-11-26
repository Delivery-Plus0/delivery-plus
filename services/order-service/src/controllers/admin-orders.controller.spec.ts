import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PermissionsGuard, PERMISSIONS_KEY, UnauthorizedError, UserRole, OrderStatus } from '@food-delivery/shared';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminListOrdersQueryDto } from '../dto/admin-list-orders-query.dto';
import { OrdersRepository } from '../repositories/orders.repository';

const ordersServiceMock = { listForAdmin: jest.fn() } as unknown as { listForAdmin: jest.Mock };

describe('AdminOrdersController (#212)', () => {
  it('requires support.read on the list route', () => {
    const required = new Reflector().get<string[]>(PERMISSIONS_KEY, AdminOrdersController.prototype.list);
    expect(required).toEqual(['support.read']);
  });

  it('returns a PaginatedResult from the service', async () => {
    const controller = new AdminOrdersController(ordersServiceMock as never);
    const query = plainToInstance(AdminListOrdersQueryDto, {});
    const result = { items: [], page: 1, limit: 20, total: 0, totalPages: 1 };
    ordersServiceMock.listForAdmin.mockResolvedValueOnce(result);

    expect(await controller.list(query)).toBe(result);
    expect(ordersServiceMock.listForAdmin).toHaveBeenCalledWith(query);
  });
});

describe('AdminListOrdersQueryDto (#212)', () => {
  it('defaults to page 1, limit 20, newest first', async () => {
    const query = plainToInstance(AdminListOrdersQueryDto, {});
    expect(await validate(query)).toHaveLength(0);
    expect(query).toMatchObject({ page: 1, limit: 20, sort: 'createdAt:desc' });
  });

  it('rejects a page size above the 100 cap', async () => {
    const query = plainToInstance(AdminListOrdersQueryDto, { limit: 101 });
    expect((await validate(query)).some((e) => e.property === 'limit')).toBe(true);
  });

  it('rejects unknown sort and status values', async () => {
    const query = plainToInstance(AdminListOrdersQueryDto, { sort: 'id:asc', status: 'weird' });
    const errors = await validate(query);
    expect(errors.some((e) => e.property === 'sort')).toBe(true);
    expect(errors.some((e) => e.property === 'status')).toBe(true);
  });

  it('maps the status group filter onto concrete statuses', () => {
    const query = plainToInstance(AdminListOrdersQueryDto, { status: 'completed' });
    expect(query.statuses()).toEqual(['DELIVERED']);
    expect(plainToInstance(AdminListOrdersQueryDto, {}).statuses()).toBeNull();
  });
});

describe('OrdersRepository.findForAdmin (#212)', () => {
  const makeRepo = (findAndCount: jest.Mock) => {
    const repo = new OrdersRepository({} as never);
    (repo as unknown as { repo: { findAndCount: jest.Mock } }).repo = { findAndCount };
    return repo;
  };

  it('passes page, limit, sort and explicit filters through', async () => {
    const findAndCount = jest.fn().mockResolvedValue([[], 0]);
    const repository = makeRepo(findAndCount);

    await repository.findForAdmin(3, 50, { statuses: [OrderStatus.DELIVERED], customerId: 'c1', sort: 'ASC' });
    expect(findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 100, take: 50, order: { createdAt: 'ASC' } }),
    );
    const options = findAndCount.mock.calls[0][0];
    expect(options.where.customerId).toBe('c1');
    // In() wraps the list in a TypeORM FindOperator
    expect(options.where.status).toMatchObject({ _type: 'in', _value: [OrderStatus.DELIVERED] });
  });

  it('treats a free-text q that is not an id as no matches (no fuzzy leaks)', async () => {
    const findAndCount = jest.fn().mockResolvedValue([[], 0]);
    const repository = makeRepo(findAndCount);

    expect(await repository.findForAdmin(1, 20, { q: 'hello world' })).toEqual([[], 0]);
    expect(findAndCount).not.toHaveBeenCalled();

    const id = '123e4567-e89b-12d3-a456-426614174000';
    await repository.findForAdmin(1, 20, { q: id });
    expect(findAndCount).toHaveBeenCalledWith(expect.objectContaining({ where: { id } }));
  });
});

describe('PermissionsGuard on admin routes (#212)', () => {
  const guard = new PermissionsGuard(new Reflector());
  const routes = { list: AdminOrdersController.prototype.list };
  const ctx = (user: unknown) =>
    ({
      getHandler: () => routes.list,
      getClass: () => AdminOrdersController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as never;

  it('lets a staff ADMIN with support.read through', () => {
    expect(guard.canActivate(ctx({ role: UserRole.ADMIN, perms: ['support.read'] }))).toBe(true);
  });

  it('answers 403 for a staff ADMIN without the permission', () => {
    expect(() => guard.canActivate(ctx({ role: UserRole.ADMIN, perms: ['ops.read'] }))).toThrow('support.read');
  });

  it('answers 401 for a SYSTEM token', () => {
    expect(() => guard.canActivate(ctx({ role: UserRole.SYSTEM, perms: ['support.read'] }))).toThrow(UnauthorizedError);
  });
});
