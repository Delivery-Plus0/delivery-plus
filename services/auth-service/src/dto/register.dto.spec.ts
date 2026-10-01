import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UserRole } from '@food-delivery/shared';
import { RegisterDto, SELF_SERVICE_ROLES } from './register.dto';

/**
 * Registration is a public trust boundary. These tests run the request body through the same
 * ValidationPipe options as main.ts, so they fail if a privileged role becomes acceptable input.
 */
describe('RegisterDto at the request boundary', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validate = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: RegisterDto }) as Promise<RegisterDto>;
  const base = { email: 'attacker@example.com', password: 'valid-password', fullName: 'Attacker' };

  it('rejects role ADMIN with 400', async () => {
    await expect(validate({ ...base, role: UserRole.ADMIN })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(Object.values(UserRole).filter((role) => !SELF_SERVICE_ROLES.includes(role)))(
    'rejects every role outside the self-service allow-list (%s)',
    async (role) => {
      await expect(validate({ ...base, role })).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it.each([['lower-case admin', 'admin'], ['array', [UserRole.ADMIN]], ['object', { role: UserRole.ADMIN }]])(
    'rejects disguised privileged values (%s)',
    async (_label, role) => {
      await expect(validate({ ...base, role })).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('rejects extra privilege-looking fields instead of ignoring them', async () => {
    await expect(validate({ ...base, isAdmin: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a normal registration without a role', async () => {
    const dto = await validate(base);
    expect(dto).toBeInstanceOf(RegisterDto);
    expect(dto.role).toBeUndefined();
  });

  it('lets an explicit null role through (the service defaults it to CUSTOMER)', async () => {
    await expect(validate({ ...base, role: null })).resolves.toMatchObject({ role: null });
  });

  it.each(SELF_SERVICE_ROLES)('accepts the self-service role %s', async (role) => {
    await expect(validate({ ...base, role })).resolves.toMatchObject({ role });
  });
});
