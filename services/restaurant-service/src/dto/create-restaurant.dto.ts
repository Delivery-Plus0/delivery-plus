import { RestaurantApplicationFieldsDto } from './restaurant-application.dto';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsLatitude, IsLongitude, IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';

export class CreateRestaurantDto extends RestaurantApplicationFieldsDto {
  @ApiProperty({
    description: 'Name of the restaurant.',
    minLength: 2,
    example: 'Sunset Grill',
  })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiPropertyOptional({
    description: 'Optional description for the restaurant.',
    example: 'Neighborhood favorite for fresh seafood and burgers.',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Street address for the restaurant location.',
    example: '123 Park Avenue, New York, NY',
  })
  @IsString()
  address!: string;

  @ApiPropertyOptional({
    description: 'Restaurant latitude. Requires longitude.',
    example: 30.0444,
  })
  @ValidateIf((dto: CreateRestaurantDto) => dto.latitude !== undefined || dto.longitude !== undefined)
  @IsLatitude({ message: 'latitude must be a latitude and is required together with longitude' })
  latitude?: number;

  @ApiPropertyOptional({
    description: 'Restaurant longitude. Requires latitude.',
    example: 31.2357,
  })
  @ValidateIf((dto: CreateRestaurantDto) => dto.latitude !== undefined || dto.longitude !== undefined)
  @IsLongitude({ message: 'longitude must be a longitude and is required together with latitude' })
  longitude?: number;
}
