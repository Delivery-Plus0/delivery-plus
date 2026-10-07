import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One code sent to a phone (#153). Only an HMAC of the code is stored; a row is used up by a correct
 * code (`consumedAt`), by running out of attempts, or by expiring. A newer row for the same user
 * replaces it: only the latest one can be verified.
 */
@Entity('phone_verifications')
@Index('IDX_phone_verifications_user_created', ['userId', 'createdAt'])
@Index('IDX_phone_verifications_phone_created', ['phone', 'createdAt'])
export class PhoneVerification {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** E.164, the number the code went to; it becomes the profile phone once verified. */
  @Column({ type: 'varchar', length: 16 })
  phone!: string;

  @Column({ type: 'varchar', length: 64, select: false })
  codeHash!: string;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
