import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One staff action (#213). Append-only: the table refuses UPDATE, DELETE and TRUNCATE
 * (migration 001), and the primary key is the event's id, so a redelivered event is stored once.
 */
@Entity('audit_events')
@Index('IDX_audit_events_target', ['targetType', 'targetId', 'occurredAt'])
@Index('IDX_audit_events_actor', ['actorId', 'occurredAt'])
export class AuditEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column('uuid')
  actorId!: string;

  @Column({ type: 'varchar', length: 320, nullable: true })
  actorEmail!: string | null;

  @Column({ type: 'varchar', length: 60 })
  permission!: string;

  @Index('IDX_audit_events_action')
  @Column({ type: 'varchar', length: 80 })
  action!: string;

  @Column({ type: 'varchar', length: 30 })
  targetType!: string;

  @Column({ type: 'varchar', length: 100 })
  targetId!: string;

  @Column({ type: 'varchar', length: 500 })
  reason!: string;

  @Column({ type: 'jsonb', nullable: true })
  before!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 40 })
  service!: string;

  @Column({ type: 'varchar', length: 100 })
  correlationId!: string;

  @Index('IDX_audit_events_occurred_at')
  @Column({ type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  recordedAt!: Date;
}
