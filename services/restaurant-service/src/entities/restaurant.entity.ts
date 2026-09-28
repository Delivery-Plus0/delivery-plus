import { RestaurantStatus } from '@food-delivery/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('restaurants')
export class Restaurant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  ownerId!: string; // userId of the RESTAURANT_OWNER, from auth-service

  @Column()
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'text', nullable: true })
  coverImageUrl?: string;

  @Column({ type: 'text', nullable: true })
  logoUrl?: string;

  @Column()
  address!: string;

  @Column({ type: 'enum', enum: RestaurantStatus, default: RestaurantStatus.CLOSED })
  status!: RestaurantStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
