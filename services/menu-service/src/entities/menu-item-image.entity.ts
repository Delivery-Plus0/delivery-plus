import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * An image of a menu item (#149), in display order. The first one is the item's primary image and
 * is mirrored into MenuItem.imageUrl, which existing clients keep reading.
 */
@Entity('menu_item_images')
@Index('IDX_menu_item_images_item_position', ['menuItemId', 'position'])
export class MenuItemImage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  menuItemId!: string;

  @Column({ type: 'varchar', length: 1024 })
  url!: string;

  @Column({ type: 'integer' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
