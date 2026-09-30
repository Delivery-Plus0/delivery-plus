import { NotificationsController } from './notifications.controller';

describe('NotificationsController', () => {
  it('marks a notification read on behalf of the authenticated user only', async () => {
    const service = { markAsRead: jest.fn().mockResolvedValue(undefined) };
    const controller = new NotificationsController(service as any);

    await expect(controller.markAsRead('n-1', { sub: 'customer-1' } as any)).resolves.toEqual({ success: true });
    expect(service.markAsRead).toHaveBeenCalledWith('n-1', 'customer-1');
  });
});
