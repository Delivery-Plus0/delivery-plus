import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsOptional, IsString, ValidateIf } from 'class-validator';

export class UpdateRestaurantDto {
  @ApiPropertyOptional({
    description: 'Updated restaurant name.',
    example: 'Sunset Grill & Bar',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Updated restaurant description.',
    example: 'Expanded menu with seasonal specials.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'Updated restaurant address.',
    example: '456 Market Street, Brooklyn, NY',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    description: 'Updated restaurant latitude. Requires longitude.',
    example: 30.0444,
  })
  @ValidateIf((dto: UpdateRestaurantDto) => dto.latitude !== undefined || dto.longitude !== undefined)
  @IsLatitude({ message: 'latitude must be a latitude and is required together with longitude' })
  latitude?: number;

  @ApiPropertyOptional({
    description: 'Updated restaurant longitude. Requires latitude.',
    example: 31.2357,
  })
  @ValidateIf((dto: UpdateRestaurantDto) => dto.latitude !== undefined || dto.longitude !== undefined)
  @IsLongitude({ message: 'longitude must be a longitude and is required together with latitude' })
  longitude?: number;
}
