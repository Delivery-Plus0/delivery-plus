import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsPositive, IsString, IsUUID, Max, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

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
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated item description.',
    example: 'Fresh basil and burrata with a crispy thin crust.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated item price.',
    minimum: 0.01,
    example: 19.5,
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(100000)
  price?: number;

}
