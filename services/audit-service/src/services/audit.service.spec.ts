import { ADMIN_ACTION_EVENT_TYPE, buildAdminActionEvent, TOPICS } from '@food-delivery/shared';
import { AuditService } from './audit.service';
import { ListAuditQueryDto } from '../dto/list-audit-query.dto';

const makeService = () => {
  const events = { append: jest.fn().mockResolvedValue(true), list: jest.fn() };
  const kafkaConsumer = { subscribe: jest.fn(), start: jest.fn() };
  return { service: new AuditService(events as never, kafkaConsumer as never), events, kafkaConsumer };
};

const event = buildAdminActionEvent({
  actor: { id: '11111111-1111-4111-8111-111111111111' },
  permission: 'users.manage',
  action: 'user.suspend',
  targetType: 'USER',
  targetId: 'user-1',
  reason: 'Fraud report',
  service: 'auth-service',
});

describe('AuditService (#213)', () => {
  it('subscribes to admin.actions and starts consuming', async () => {
    const { service, kafkaConsumer } = makeService();
    await service.onModuleInit();
    expect(kafkaConsumer.subscribe).toHaveBeenCalledWith(TOPICS.ADMIN_ACTIONS, ADMIN_ACTION_EVENT_TYPE, expect.any(Function));
    expect(kafkaConsumer.start).toHaveBeenCalled();
  });

  it('appends each consumed event', async () => {
    const { service, events, kafkaConsumer } = makeService();
    await service.onModuleInit();
    const handler = kafkaConsumer.subscribe.mock.calls[0][2];
    await handler(event);
    expect(events.append).toHaveBeenCalledWith(event);
  });

  it('never logs the reason or the changed values', async () => {
    const { service } = makeService();
    const log = jest.spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => undefined);
    await service.record(event);
    expect(log.mock.calls[0][0]).toContain('action=user.suspend');
    expect(log.mock.calls[0][0]).not.toContain('Fraud report');
  });

  it('returns a PaginatedResult', async () => {
    const { service, events } = makeService();
    events.list.mockResolvedValue([[{ id: 'a' }], 51]);
    const query = Object.assign(new ListAuditQueryDto(), { page: 2, limit: 50 });
    expect(await service.list(query)).toEqual({ items: [{ id: 'a' }], page: 2, limit: 50, total: 51, totalPages: 2 });
  });
});
