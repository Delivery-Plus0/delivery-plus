import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

export const NAME_MAX = 100;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** PATCH /categories/:id (#148): rename and/or move. */
export class UpdateCategoryDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: NAME_MAX, example: 'Burgers' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(NAME_MAX)
  name?: string;

  @ApiPropertyOptional({ minimum: 0, example: 2 })
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

/** PATCH /restaurants/:restaurantId/categories/order (#148): every category of the restaurant, in display order. */
export class ReorderCategoriesDto {
  @ApiProperty({ type: [String], description: 'All category ids of the restaurant, first to last.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  categoryIds!: string[];
}
