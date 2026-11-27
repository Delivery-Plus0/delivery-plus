import { TOPICS } from '../events/topics';
import { OUTBOX_TABLE } from '../outbox/outbox';
import { AdminAudit, auditDiff, buildAdminActionEvent, REDACTED, redactAuditFields } from './admin-audit';

const input = {
  actor: { id: 'staff-1', email: 'ops@example.com' },
  permission: 'onboarding.review',
  action: 'driver.approve',
  targetType: 'DRIVER' as const,
  targetId: 'driver-1',
  reason: '  Documents verified  ',
  before: { verificationStatus: 'PENDING', name: 'Ali' },
  after: { verificationStatus: 'VERIFIED', name: 'Ali' },
  service: 'driver-service',
  occurredAt: new Date('2026-11-27T10:00:00Z'),
};

describe('AdminAudit (#213)', () => {
  it('stages one admin.actions event in the caller transaction, via the outbox', async () => {
    const tx = { query: jest.fn().mockResolvedValue([]) };
    const event = await AdminAudit.record(tx, input);

    expect(tx.query).toHaveBeenCalledTimes(1);
    const [sql, params] = tx.query.mock.calls[0];
    expect(sql).toContain(`INSERT INTO "${OUTBOX_TABLE}"`);
    expect(params[0]).toBe(event.eventId);
    expect(params[1]).toBe(TOPICS.ADMIN_ACTIONS);
    expect(JSON.parse(params[2])).toEqual(event);
  });

  it('keeps only the changed fields and trims the reason', () => {
    const { payload } = buildAdminActionEvent(input);
    expect(payload).toMatchObject({
      actorId: 'staff-1',
      actorEmail: 'ops@example.com',
      action: 'driver.approve',
      reason: 'Documents verified',
      before: { verificationStatus: 'PENDING' },
      after: { verificationStatus: 'VERIFIED' },
      occurredAt: '2026-11-27T10:00:00.000Z',
    });
    expect(payload.before).not.toHaveProperty('name');
  });

  it('refuses an action without a reason or an actor', () => {
    expect(() => buildAdminActionEvent({ ...input, reason: '   ' })).toThrow('needs a reason');
    expect(() => buildAdminActionEvent({ ...input, actor: { id: '' } })).toThrow('needs the staff actor');
  });

  it('uses the given eventId, so a retried action is one event', () => {
    expect(buildAdminActionEvent({ ...input, eventId: 'e-1' }).eventId).toBe('e-1');
  });
});

describe('redactAuditFields (#213)', () => {
  it('redacts secrets, codes, document locations and phone numbers, recursively', () => {
    expect(
      redactAuditFields({
        passwordHash: 'x',
        refreshToken: 'y',
        otp: '123456',
        licenceDocumentUrl: 'https://bucket/doc',
        documentKey: 'drivers/1/licence.pdf',
        phone: '+201000000000',
        nested: { contactPhone: '+201', apiKey: 'k' },
        status: 'SUSPENDED',
        countryCode: 'EG',
      }),
    ).toEqual({
      passwordHash: REDACTED,
      refreshToken: REDACTED,
      otp: REDACTED,
      licenceDocumentUrl: REDACTED,
      documentKey: REDACTED,
      phone: REDACTED,
      nested: { contactPhone: REDACTED, apiKey: REDACTED },
      status: 'SUSPENDED',
      countryCode: 'EG',
    });
  });

  it('diffs a creation and a removal whole, and an unchanged update as nothing', () => {
    expect(auditDiff(null, { status: 'ACTIVE' })).toEqual({ after: { status: 'ACTIVE' } });
    expect(auditDiff({ status: 'ACTIVE' }, null)).toEqual({ before: { status: 'ACTIVE' } });
    expect(auditDiff({ status: 'ACTIVE' }, { status: 'ACTIVE' })).toEqual({});
  });
});
