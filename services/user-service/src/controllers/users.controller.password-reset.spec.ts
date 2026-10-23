import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UsersController } from './users.controller';
import { InternalAuthGuard } from '../guards/internal-auth.guard';

describe('UsersController password reset routes (#35)', () => {
  const phoneVerification = { startPasswordReset: jest.fn(), verifyPasswordReset: jest.fn() };
  const controller = new UsersController({} as never, phoneVerification as never);

  it('guards both routes with the internal HMAC guard', () => {
    for (const handler of [controller.sendPasswordResetCode, controller.verifyPasswordResetCode]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(InternalAuthGuard);
    }
  });

  it('send answers the same body whatever the service does', async () => {
    phoneVerification.startPasswordReset.mockResolvedValue(undefined);
    await expect(controller.sendPasswordResetCode({ phone: '+201012345678' })).resolves.toEqual({ accepted: true });
  });

  it('verify returns only the user id', async () => {
    phoneVerification.verifyPasswordReset.mockResolvedValue({ userId: 'u-1' });
    await expect(controller.verifyPasswordResetCode({ phone: '+201012345678', code: '123456' })).resolves.toEqual({ userId: 'u-1' });
    expect(phoneVerification.verifyPasswordReset).toHaveBeenCalledWith('+201012345678', '123456');
  });
});