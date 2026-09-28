import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsPositive, IsString, IsUUID } from 'class-validator';

export class UpdateMenuItemDto {
  @ApiPropertyOptional({
    description: 'Updated category UUID for the menu item.',
    format: 'uuid',
    example: '4d5403d8-dfd4-4be7-a890-9c7353f6a8d0',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    description: 'Updated item name.',
    example: 'Margherita Pizza Deluxe',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated item description.',
    example: 'Fresh basil and burrata with a crispy thin crust.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated item price.',
    minimum: 0.01,
    example: 19.5,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  price?: number;

}
