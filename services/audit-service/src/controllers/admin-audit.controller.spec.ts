import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PermissionsGuard, PERMISSIONS_KEY, UnauthorizedError, UserRole } from '@food-delivery/shared';
import { AdminAuditController } from './admin-audit.controller';
import { ListAuditQueryDto } from '../dto/list-audit-query.dto';

describe('AdminAuditController (#213)', () => {
  it('requires audit.read', () => {
    expect(new Reflector().get<string[]>(PERMISSIONS_KEY, AdminAuditController.prototype.list)).toEqual(['audit.read']);
  });

  it('is read-only: the controller has no mutation', () => {
    const methods = Object.getOwnPropertyNames(AdminAuditController.prototype).filter((name) => name !== 'constructor');
    expect(methods).toEqual(['list']);
  });

  const guard = new PermissionsGuard(new Reflector());
  const ctx = (user: unknown) =>
    ({
      getHandler: () => AdminAuditController.prototype.list,
      getClass: () => AdminAuditController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as never;

  it('lets staff with audit.read in, refuses other staff with 403 and SYSTEM with 401', () => {
    expect(guard.canActivate(ctx({ role: UserRole.ADMIN, perms: ['audit.read'] }))).toBe(true);
    expect(() => guard.canActivate(ctx({ role: UserRole.ADMIN, perms: ['support.read'] }))).toThrow('audit.read');
    expect(() => guard.canActivate(ctx({ role: UserRole.SYSTEM, perms: ['audit.read'] }))).toThrow(UnauthorizedError);
  });
});

describe('ListAuditQueryDto (#213)', () => {
  it('defaults to page 1 of 50', async () => {
    const query = plainToInstance(ListAuditQueryDto, {});
    expect(await validate(query)).toHaveLength(0);
    expect(query).toMatchObject({ page: 1, limit: 50 });
  });

  it('rejects a page above 100, a non-UUID actor, an unknown target type, a malformed action and a bad date', async () => {
    const query = plainToInstance(ListAuditQueryDto, { limit: 101, actorId: 'x', targetType: 'CAT', action: 'DROP TABLE', from: 'yesterday' });
    const properties = (await validate(query)).map((e) => e.property);
    expect(properties).toEqual(expect.arrayContaining(['limit', 'actorId', 'targetType', 'action', 'from']));
  });
});
