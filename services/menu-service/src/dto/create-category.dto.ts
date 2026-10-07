import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateCategoryDto {
  @ApiProperty({
    description: 'UUID of the restaurant that owns this menu category.',
    format: 'uuid',
    example: '6a114d5c-2ef2-493d-ae90-24ff7d8f6058',
  })
  @IsUUID()
  restaurantId!: string;

  @ApiProperty({
    description: 'Name of the category to create.',
    example: 'Appetizers',
  })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description: 'Display order for the category within the menu.',
    minimum: 0,
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}
