import { MigrationInterface, QueryRunner } from 'typeorm';
import { OUTBOX_CREATE_SQL, OUTBOX_DROP_SQL } from '@food-delivery/shared';

/**
 * Transactional outbox (#98, #213): staff actions on this service write their audit event here in the
 * same transaction as the change (`AdminAudit.record`), and the relay publishes it to `admin.actions`.
 * Additive only; safe to run before the new code is deployed.
 */
export class OutboxEvents1700000000005 implements MigrationInterface {
  name = 'OutboxEvents1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of OUTBOX_CREATE_SQL) {
      await queryRunner.query(statement);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(OUTBOX_DROP_SQL);
  }
}
