import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsPositive, IsString, IsUUID, Max, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateMenuItemDto {
  @ApiProperty({
    description: 'UUID of the restaurant that owns this menu item.',
    format: 'uuid',
    example: '6a114d5c-2ef2-493d-ae90-24ff7d8f6058',
  })
  @IsUUID()
  restaurantId!: string;

  @ApiPropertyOptional({
    description: 'Optional category UUID for grouping the item within the menu.',
    format: 'uuid',
    example: '4d5403d8-dfd4-4be7-a890-9c7353f6a8d0',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    description: 'Name of the menu item.',
    example: 'Margherita Pizza',
  })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description: 'Optional description of the menu item.',
    example: 'Fresh basil, mozzarella, and tomato sauce on a thin crust.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    description: 'Price of the menu item in the shop currency.',
    minimum: 0.01,
    example: 18.5,
  })
  @IsNumber()
  @IsPositive()
  @Max(100000)
  price!: number;

}
