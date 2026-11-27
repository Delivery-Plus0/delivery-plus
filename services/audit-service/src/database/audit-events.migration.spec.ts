import { AuditEvents1700000000000 } from './migrations/001-audit-events';

describe('AuditEvents migration (#213)', () => {
  it('makes the table append-only with triggers and revoked grants', async () => {
    const statements: string[] = [];
    await new AuditEvents1700000000000().up({ query: async (sql: string) => statements.push(sql) } as never);
    const all = statements.join('\n');
    expect(all).toContain('CREATE TRIGGER "TRG_audit_events_append_only"');
    expect(all).toContain('BEFORE UPDATE OR DELETE ON "audit_events"');
    expect(all).toContain('BEFORE TRUNCATE ON "audit_events"');
    expect(all).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM CURRENT_USER');
  });
});
