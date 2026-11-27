import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERMISSIONS_KEY } from '@food-delivery/shared';
import { AdminUsersController } from './admin-users.controller';
import { AdminListUsersQueryDto, AdminSearchUsersDto } from '../dto/admin-users.dto';

describe('AdminUsersController (#214)', () => {
  it('requires support.read on every route', () => {
    for (const route of ['list', 'search', 'detail'] as const) {
      expect(new Reflector().get(PERMISSIONS_KEY, AdminUsersController.prototype[route])).toEqual(['support.read']);
    }
  });
});

describe('admin users DTOs (#214)', () => {
  it('reads booleans from the query string and caps the page at 100', async () => {
    const query = plainToInstance(AdminListUsersQueryDto, { emailVerified: 'false', phoneVerified: 'true', limit: '100' });
    expect(await validate(query)).toHaveLength(0);
    expect(query).toMatchObject({ emailVerified: false, phoneVerified: true, limit: 100 });
    const errors = await validate(plainToInstance(AdminListUsersQueryDto, { limit: 101, q: 'a', role: 'SYSTEM', createdFrom: 'today' }));
    expect(errors.map((e) => e.property)).toEqual(expect.arrayContaining(['limit', 'q', 'role', 'createdFrom']));
  });

  it('normalizes the searched phone to E.164 and the email to lowercase', async () => {
    const phone = plainToInstance(AdminSearchUsersDto, { phone: '01012345678' });
    expect(await validate(phone)).toHaveLength(0);
    expect(phone.phone).toBe('+201012345678');
    const email = plainToInstance(AdminSearchUsersDto, { email: '  Someone@Example.COM ' });
    expect(await validate(email)).toHaveLength(0);
    expect(email.email).toBe('someone@example.com');
    expect(await validate(plainToInstance(AdminSearchUsersDto, { phone: '123' }))).not.toHaveLength(0);
  });
});
