import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERMISSIONS_KEY, PermissionsGuard } from '@food-delivery/shared';
import { AdminStaffController } from './admin-staff.controller';
import { AcceptStaffInvitationDto, InviteStaffDto } from '../dto/staff.dto';
import { AdminAccountsController } from './admin-accounts.controller';

describe('AdminStaffController (#216)', () => {
  it('needs staff.manage on every route', () => {
    for (const route of ['list', 'templates', 'invite', 'setPermissions', 'disable', 'enable'] as const) {
      expect(new Reflector().get(PERMISSIONS_KEY, AdminStaffController.prototype[route])).toEqual(['staff.manage']);
    }
    expect(Reflect.getMetadata('__guards__', AdminStaffController)).toContain(PermissionsGuard);
  });

  it('needs users.manage on the account actions (#215)', () => {
    for (const route of ['suspend', 'reactivate', 'revokeSessions'] as const) {
      expect(new Reflector().get(PERMISSIONS_KEY, AdminAccountsController.prototype[route])).toEqual(['users.manage']);
    }
  });
});

describe('staff DTOs (#216)', () => {
  it('accepts only known permissions and lowercases the email', async () => {
    const dto = plainToInstance(InviteStaffDto, { email: ' New.Agent@Example.COM ', permissions: ['support.read'], reason: 'New hire' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.email).toBe('new.agent@example.com');
    const bad = await validate(plainToInstance(InviteStaffDto, { email: 'x@example.com', permissions: ['root'], reason: 'r' }));
    expect(bad.map((e) => e.property)).toEqual(expect.arrayContaining(['permissions', 'reason']));
  });

  it('asks staff for a password of at least 12 characters', async () => {
    const base = { token: 'a'.repeat(43), fullName: 'Mona Ali', phone: '01012345678' };
    expect((await validate(plainToInstance(AcceptStaffInvitationDto, { ...base, password: 'elevenchars' }))).map((e) => e.property)).toEqual(['password']);
    expect(await validate(plainToInstance(AcceptStaffInvitationDto, { ...base, password: 'twelve-chars' }))).toHaveLength(0);
  });
});
