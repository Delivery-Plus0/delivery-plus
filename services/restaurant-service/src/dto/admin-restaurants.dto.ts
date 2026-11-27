import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { EgyptianMobile, RestaurantStatus } from '@food-delivery/shared';
import { RESTAURANT_APPROVAL_STATUSES } from '../entities/restaurant.entity';

class AdminPageQuery {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/** `GET /admin/restaurants` (#214). Search by phone is `POST /admin/restaurants/search`, never a query string. */
export class AdminListRestaurantsQueryDto extends AdminPageQuery {
  @ApiPropertyOptional({ enum: RESTAURANT_APPROVAL_STATUSES })
  @IsOptional()
  @IsIn(RESTAURANT_APPROVAL_STATUSES)
  approvalStatus?: (typeof RESTAURANT_APPROVAL_STATUSES)[number];

  @ApiPropertyOptional({ enum: RestaurantStatus })
  @IsOptional()
  @IsEnum(RestaurantStatus)
  status?: RestaurantStatus;

  @ApiPropertyOptional({ description: 'The start of the name or of a later word, case-insensitive, at least 2 characters.' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(2)
  @MaxLength(60)
  q?: string;

  /** The area filter: restaurants within `withinKm` of (nearLat, nearLng). All three or none. */
  @ApiPropertyOptional({ description: 'Area: latitude of the centre.' })
  @ValidateIf((o: AdminListRestaurantsQueryDto) => o.nearLng !== undefined || o.withinKm !== undefined || o.nearLat !== undefined)
  @Type(() => Number)
  @IsLatitude()
  nearLat?: number;

  @ApiPropertyOptional({ description: 'Area: longitude of the centre.' })
  @ValidateIf((o: AdminListRestaurantsQueryDto) => o.nearLat !== undefined || o.withinKm !== undefined || o.nearLng !== undefined)
  @Type(() => Number)
  @IsLongitude()
  nearLng?: number;

  @ApiPropertyOptional({ description: 'Area: radius in km, at most 50.', minimum: 0.1, maximum: 50 })
  @ValidateIf((o: AdminListRestaurantsQueryDto) => o.nearLat !== undefined || o.nearLng !== undefined || o.withinKm !== undefined)
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(50)
  withinKm?: number;
}

/** `GET /admin/restaurants/queue` (#214): submitted applications, oldest first. */
export class AdminRestaurantQueueQueryDto extends AdminPageQuery {}

/** `POST /admin/restaurants/search` (#214, #217 decision): the contact phone, exact, in the body. */
export class AdminSearchRestaurantsDto {
  @ApiPropertyOptional({ example: '01012345678' })
  @EgyptianMobile()
  phone!: string;
}
