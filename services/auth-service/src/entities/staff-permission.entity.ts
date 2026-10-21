import { Column, Entity, PrimaryColumn } from 'typeorm';
import { StaffPermission as Permission } from '@food-delivery/shared';

/** One permission held by one staff member (#202). Read when an access token is issued. */
@Entity('staff_permissions')
export class StaffPermission {
  @PrimaryColumn('uuid')
  credentialId!: string;

  @PrimaryColumn({ type: 'varchar', length: 40 })
  permission!: Permission;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  grantedAt!: Date;
}
