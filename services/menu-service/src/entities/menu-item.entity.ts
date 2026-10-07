import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('menu_items')
export class MenuItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  restaurantId!: string;

  @Index()
  @Column({ nullable: true })
  categoryId?: string;

  @Column()
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column('decimal', { precision: 10, scale: 2 })
  price!: string; // stored as string by TypeORM for `decimal` to avoid float rounding

  @Column({ nullable: true })
  imageUrl?: string;

  @Column({ default: true })
  available!: boolean;

  /**
   * Set when the owner archives the item (#148) instead of deleting it: it disappears from the menu and
   * can't be bought (available is false too), but stays a valid reference for past orders and carts.
   */
  @Column({ type: 'timestamptz', nullable: true })
  archivedAt?: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
