import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { StaffPermission } from '@food-delivery/shared';

/** #216: one invitation to become staff. The token itself is never stored, only its SHA-256. */
@Entity('staff_invitations')
export class StaffInvitation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 40, array: true })
  permissions!: StaffPermission[];

  @Column({ type: 'char', length: 64 })
  tokenHash!: string;

  @Column('uuid')
  invitedBy!: string;

  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  acceptedCredentialId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
