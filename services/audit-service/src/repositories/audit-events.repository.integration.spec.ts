/**
 * The audit log against real PostgreSQL (#213): the real migration builds the schema, so this proves
 * that a redelivered event is stored once, that the filters and the newest-first order work, and that
 * the table refuses UPDATE, DELETE and TRUNCATE.
 *
 * Opt-in: set AUDIT_TEST_DATABASE_URL to a DISPOSABLE database (the public schema is dropped and
 * recreated). Without it the suite is skipped so `npm test` works without Postgres.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AdminActionEvent, AdminAudit, buildAdminActionEvent, OUTBOX_CREATE_SQL, OutboxRelay, TOPICS } from '@food-delivery/shared';
import { AuditEvent } from '../entities/audit-event.entity';
import { AuditEvents1700000000000, AUDIT_APPEND_ONLY_MESSAGE } from '../database/migrations/001-audit-events';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { ListAuditQueryDto } from '../dto/list-audit-query.dto';
import { AuditEventsRepository } from './audit-events.repository';

const DATABASE_URL = process.env.AUDIT_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const query = (overrides: Partial<ListAuditQueryDto> = {}) => Object.assign(new ListAuditQueryDto(), overrides);

const event = (overrides: { action?: string; targetId?: string; actorId?: string; at?: string } = {}) =>
  buildAdminActionEvent({
    actor: { id: overrides.actorId ?? randomUUID(), email: 'ops@example.com' },
    permission: 'onboarding.review',
    action: overrides.action ?? 'driver.approve',
    targetType: 'DRIVER',
    targetId: overrides.targetId ?? randomUUID(),
    reason: 'Documents verified',
    before: { verificationStatus: 'PENDING' },
    after: { verificationStatus: 'VERIFIED' },
    service: 'driver-service',
    occurredAt: new Date(overrides.at ?? '2026-11-27T10:00:00Z'),
  });

describeDb('AuditEventsRepository (PostgreSQL integration, #213)', () => {
  jest.setTimeout(30_000);
  let dataSource: DataSource;
  let repository: AuditEventsRepository;

  beforeAll(async () => {
    dataSource = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [AuditEvent], { migrations: [AuditEvents1700000000000] }));
    await dataSource.initialize();
    await dataSource.query('DROP SCHEMA public CASCADE');
    await dataSource.query('CREATE SCHEMA public');
    await dataSource.runMigrations();
    repository = new AuditEventsRepository(dataSource.getRepository(AuditEvent));
  });

  afterAll(async () => {
    await dataSource?.destroy();
  });

  it('stores a redelivered event once', async () => {
    const e = event();
    expect(await repository.append(e)).toBe(true);
    expect(await repository.append(e)).toBe(false);
    const [rows, total] = await repository.list(query({ targetId: e.payload.targetId }));
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({
      id: e.eventId,
      action: 'driver.approve',
      reason: 'Documents verified',
      before: { verificationStatus: 'PENDING' },
      after: { verificationStatus: 'VERIFIED' },
    });
  });

  it('filters by actor, action and a half-open time range, newest first', async () => {
    const actorId = randomUUID();
    await repository.append(event({ actorId, action: 'user.suspend', at: '2026-11-01T08:00:00Z' }));
    await repository.append(event({ actorId, action: 'user.suspend', at: '2026-11-02T08:00:00Z' }));
    await repository.append(event({ actorId, action: 'user.reactivate', at: '2026-11-03T08:00:00Z' }));

    const [suspensions] = await repository.list(query({ actorId, action: 'user.suspend' }));
    expect(suspensions.map((r) => r.occurredAt.toISOString())).toEqual(['2026-11-02T08:00:00.000Z', '2026-11-01T08:00:00.000Z']);

    const [range] = await repository.list(query({ actorId, from: '2026-11-02T08:00:00Z', to: '2026-11-03T08:00:00Z' }));
    expect(range.map((r) => r.action)).toEqual(['user.suspend']);
  });

  it('refuses UPDATE, DELETE and TRUNCATE', async () => {
    await repository.append(event());
    await expect(dataSource.query(`UPDATE "audit_events" SET "reason" = 'changed'`)).rejects.toThrow(AUDIT_APPEND_ONLY_MESSAGE);
    await expect(dataSource.query(`DELETE FROM "audit_events"`)).rejects.toThrow(AUDIT_APPEND_ONLY_MESSAGE);
    await expect(dataSource.query(`TRUNCATE "audit_events"`)).rejects.toThrow(AUDIT_APPEND_ONLY_MESSAGE);
  });

  it('keeps an audit event committed with its change through a crash before publish, and publishes it once', async () => {
    // The acting service's side, in the same database for the test: a state table and the outbox.
    for (const statement of OUTBOX_CREATE_SQL) await dataSource.query(statement);
    await dataSource.query(`CREATE TABLE IF NOT EXISTS "test_drivers" ("id" uuid PRIMARY KEY, "status" varchar(20) NOT NULL)`);
    const driverId = randomUUID();
    await dataSource.query(`INSERT INTO "test_drivers" VALUES ($1, 'PENDING')`, [driverId]);

    // The admin mutation: the change and its audit event commit together.
    const staged = await dataSource.transaction(async (manager) => {
      await manager.query(`UPDATE "test_drivers" SET "status" = 'VERIFIED' WHERE "id" = $1 AND "status" = 'PENDING'`, [driverId]);
      return AdminAudit.record(manager, {
        actor: { id: randomUUID() },
        permission: 'onboarding.review',
        action: 'driver.approve',
        targetType: 'DRIVER',
        targetId: driverId,
        reason: 'Documents verified',
        before: { status: 'PENDING' },
        after: { status: 'VERIFIED' },
        service: 'driver-service',
      });
    });

    // A rolled-back mutation leaves no event.
    await expect(
      dataSource.transaction(async (manager) => {
        await AdminAudit.record(manager, {
          actor: { id: staged.payload.actorId },
          permission: 'onboarding.review',
          action: 'driver.reject',
          targetType: 'DRIVER',
          targetId: driverId,
          reason: 'Blurry licence',
          service: 'driver-service',
        });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    // "Crash": nothing was published. A new process's relay finds the event; the first publish fails
    // (Kafka down), the next run delivers it.
    const delivered: AdminActionEvent[] = [];
    let kafkaUp = false;
    const relay = new OutboxRelay(
      dataSource,
      async (topic, event) => {
        if (!kafkaUp) throw new Error('kafka down');
        expect(topic).toBe(TOPICS.ADMIN_ACTIONS);
        delivered.push(event as AdminActionEvent);
      },
      { lockName: 'audit-integration-test' },
    );
    const [{ count }] = await dataSource.query(`SELECT count(*)::int AS "count" FROM "outbox_events"`);
    expect(count).toBe(1); // the rolled-back action left nothing
    expect(await relay.drainOnce()).toBe(0);
    kafkaUp = true;
    expect(await relay.drainOnce()).toBe(1);
    expect(await relay.drainOnce()).toBe(0);
    expect(delivered.map((e) => e.eventId)).toEqual([staged.eventId]);

    // The consumer side stores it, once, even if Kafka redelivers it.
    expect(await repository.append(delivered[0])).toBe(true);
    expect(await repository.append(delivered[0])).toBe(false);
    const [rows] = await repository.list(query({ targetType: 'DRIVER', targetId: driverId }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'driver.approve', after: { status: 'VERIFIED' } });
  });
});
