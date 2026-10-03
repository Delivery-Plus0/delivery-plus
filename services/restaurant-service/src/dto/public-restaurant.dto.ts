import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RestaurantStatus } from '@food-delivery/shared';

export class PublicRestaurantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  description?: string | null;

  @ApiPropertyOptional({ nullable: true })
  coverImageUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  logoUrl?: string | null;

  @ApiProperty()
  address!: string;

  @ApiProperty({ enum: RestaurantStatus, enumName: 'RestaurantStatus' })
  status!: RestaurantStatus;
}

export class PublicRestaurantListResponseDto {
  @ApiProperty({ type: [PublicRestaurantDto] })
  items!: PublicRestaurantDto[];

  @ApiProperty({ minimum: 1 })
  page!: number;

  @ApiProperty({ minimum: 1 })
  limit!: number;

  @ApiProperty({ minimum: 0 })
  total!: number;

  @ApiProperty({ minimum: 1 })
  totalPages!: number;
}