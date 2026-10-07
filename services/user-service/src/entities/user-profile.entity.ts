import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('user_profiles')
export class UserProfile {
  @PrimaryColumn('uuid')
  id!: string; // same value as the credential id in auth-service (shared userId)

  @Column({ type: 'uuid', unique: true })
  authCredentialId!: string; // explicit 1:1 mapping to auth-service Credential.id

  @Column()
  createdByService!: string; // verified internal caller that created the profile

  @Column()
  email!: string;

  @Column()
  fullName!: string;

  @Column({ nullable: true })
  phone?: string;

  /** Set when the current phone was confirmed by a one-time code (#153); cleared when the phone changes. */
  @Column({ type: 'timestamptz', nullable: true })
  phoneVerifiedAt?: Date | null;

  @Column({ nullable: true })
  address?: string;

  @Column({ type: 'text', nullable: true })
  avatarUrl?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
