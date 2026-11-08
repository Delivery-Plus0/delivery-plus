import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

export type ContactField = 'customerPhone' | 'restaurantPhone' | 'driverPhone';

/** #211: a participant was shown another participant's phone for a delivery. Never the number. */
@Entity('delivery_contact_reveals')
@Unique('UQ_delivery_contact_reveals', ['deliveryId', 'viewerUserId', 'field'])
export class DeliveryContactReveal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  deliveryId!: string;

  @Column({ type: 'uuid' })
  viewerUserId!: string;

  @Column({ type: 'varchar', length: 30 })
  viewerRole!: string;

  @Column({ type: 'varchar', length: 30 })
  field!: ContactField;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  firstRevealedAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  lastRevealedAt!: Date;

  @Column({ type: 'integer', default: 1 })
  revealCount!: number;
}
