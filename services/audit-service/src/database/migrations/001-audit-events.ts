import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The staff audit log (#213). Append-only twice over:
 * - a trigger raises on any UPDATE, DELETE or TRUNCATE, whoever runs it;
 * - UPDATE, DELETE and TRUNCATE are revoked from the service's own database user and PUBLIC.
 * Dropping the table needs the schema owner and a migration, which is reviewed like any code.
 */
export const AUDIT_APPEND_ONLY_MESSAGE = 'audit_events is append-only';

export class AuditEvents1700000000000 implements MigrationInterface {
  name = 'AuditEvents1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audit_events" (
        "id" uuid PRIMARY KEY,
        "actorId" uuid NOT NULL,
        "actorEmail" varchar(320),
        "permission" varchar(60) NOT NULL,
        "action" varchar(80) NOT NULL,
        "targetType" varchar(30) NOT NULL,
        "targetId" varchar(100) NOT NULL,
        "reason" varchar(500) NOT NULL,
        "before" jsonb,
        "after" jsonb,
        "service" varchar(40) NOT NULL,
        "correlationId" varchar(100) NOT NULL,
        "occurredAt" timestamptz NOT NULL,
        "recordedAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_events_target" ON "audit_events" ("targetType", "targetId", "occurredAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_events_actor" ON "audit_events" ("actorId", "occurredAt")`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_events_action" ON "audit_events" ("action")`);
    await queryRunner.query(`CREATE INDEX "IDX_audit_events_occurred_at" ON "audit_events" ("occurredAt")`);

    await queryRunner.query(`
      CREATE FUNCTION "audit_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '${AUDIT_APPEND_ONLY_MESSAGE}' USING ERRCODE = 'insufficient_privilege';
      END
      $$`);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_audit_events_append_only"
      BEFORE UPDATE OR DELETE ON "audit_events"
      FOR EACH ROW EXECUTE FUNCTION "audit_events_append_only"()`);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_audit_events_no_truncate"
      BEFORE TRUNCATE ON "audit_events"
      FOR EACH STATEMENT EXECUTE FUNCTION "audit_events_append_only"()`);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM PUBLIC`);
    await queryRunner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON "audit_events" FROM CURRENT_USER`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_events"`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS "audit_events_append_only"()`);
  }
}
