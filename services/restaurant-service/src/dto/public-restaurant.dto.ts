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

  @ApiProperty({ type: 'number', nullable: true, example: 30.0444 })
  latitude!: number | null;

  @ApiProperty({ type: 'number', nullable: true, example: 31.2357 })
  longitude!: number | null;

  @ApiProperty({ description: 'Effective delivery radius in kilometers.', example: 5 })
  deliveryRadiusKm!: number;

  @ApiPropertyOptional({ description: 'Distance from the query point, in kilometers.', example: 2.4 })
  distanceKm?: number;

  @ApiProperty({ enum: RestaurantStatus, enumName: 'RestaurantStatus' })
  status!: RestaurantStatus;

  @ApiProperty({
    enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
    description: '#208: always APPROVED on public routes; the owner sees their own application status on /restaurants/me.',
  })
  approvalStatus!: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';

  @ApiProperty({ type: [String], description: '#208: up to 5 cuisine labels.', example: ['Burgers'] })
  cuisineTags!: string[];
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