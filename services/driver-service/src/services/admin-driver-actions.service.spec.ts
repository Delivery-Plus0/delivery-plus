import { TOPICS } from '@food-delivery/shared';
import { AdminDriverActionsService } from './admin-driver-actions.service';

const actor = { id: '11111111-1111-4111-8111-111111111111', email: 'ops@example.com' };

const setup = () => {
  const manager = { query: jest.fn().mockResolvedValue([]) };
  const dataSource = { transaction: jest.fn((work: (m: unknown) => unknown) => work(manager)) };
  const drivers = { findById: jest.fn(), suspend: jest.fn(), reactivate: jest.fn() };
  const applications = { review: jest.fn() };
  const outbox = { kick: jest.fn() };
  const service = new AdminDriverActionsService(dataSource as never, drivers as never, applications as never, outbox as never);
  return { service, manager, drivers, applications, outbox };
};
const staged = (manager: { query: jest.Mock }) =>
  manager.query.mock.calls.filter(([sql]) => String(sql).includes('outbox_events')).map(([, params]) => ({ topic: params[1], event: JSON.parse(params[2]) }));

describe('AdminDriverActionsService (#215)', () => {
  it('audits a review in its transaction and tells the driver, with the note but not the reason', async () => {
    const { service, manager, applications, outbox } = setup();
    applications.review.mockImplementation(async (_r, _id, _dto, _now, onDecided) => {
      await onDecided(manager, { userId: 'user-1', verificationStatus: 'PENDING' });
      return { id: 'd1' };
    });

    await service.review(actor, 'd1', { decision: 'REJECTED', note: 'Retake the licence photo', submittedAt: '2026-11-20T00:00:00.000Z', reason: 'Blurry photo' });

    const [{ topic, event }] = staged(manager);
    expect(topic).toBe(TOPICS.ADMIN_ACTIONS);
    expect(event.payload).toMatchObject({
      action: 'driver.reject',
      permission: 'onboarding.review',
      reason: 'Blurry photo',
      before: { verificationStatus: 'PENDING' },
      after: { verificationStatus: 'REJECTED' },
      notify: { userId: 'user-1', messageKey: 'driver.application_rejected', params: { note: 'Retake the licence photo' } },
    });
    expect(JSON.stringify(event.payload.notify)).not.toContain('Blurry photo');
    expect(outbox.kick).toHaveBeenCalled();
  });

  it('records nothing for a repeated review (the hook is not called)', async () => {
    const { service, manager, applications } = setup();
    applications.review.mockResolvedValue({ id: 'd1' });
    await service.review(actor, 'd1', { decision: 'VERIFIED', submittedAt: '2026-11-20T00:00:00.000Z', reason: 'All good' });
    expect(staged(manager)).toHaveLength(0);
  });

  it('suspends with one audit event and one notice, and a no-op suspend records nothing', async () => {
    const { service, manager, drivers, outbox } = setup();
    drivers.findById.mockResolvedValue({ id: 'd1', userId: 'user-1', status: 'SUSPENDED', suspensionRequestedAt: null });
    drivers.suspend.mockResolvedValueOnce({ before: { status: 'AVAILABLE', suspensionRequested: false }, after: { status: 'SUSPENDED', suspensionRequested: false } });

    await expect(service.suspend(actor, 'd1', 'Fraud report')).resolves.toMatchObject({ changed: true, driver: { status: 'SUSPENDED' } });
    expect(staged(manager).map((s) => s.event.payload)).toEqual([
      expect.objectContaining({ action: 'driver.suspend', permission: 'ops.act', notify: { userId: 'user-1', messageKey: 'driver.suspended' } }),
    ]);

    drivers.suspend.mockResolvedValueOnce(null);
    outbox.kick.mockClear();
    await expect(service.suspend(actor, 'd1', 'Fraud report')).resolves.toMatchObject({ changed: false });
    expect(staged(manager)).toHaveLength(1);
    expect(outbox.kick).not.toHaveBeenCalled();
  });

  it('404s an unknown driver', async () => {
    const { service, drivers } = setup();
    drivers.findById.mockResolvedValue(null);
    await expect(service.reactivate(actor, 'missing', 'Appeal accepted')).rejects.toThrow('not found');
  });
});
