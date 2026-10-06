import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsLatitude, IsLongitude, IsOptional } from 'class-validator';

export class UpdateLocationDto {
  @ApiProperty({
    description: 'Latitude of the driver location in decimal degrees.',
    minimum: -90,
    maximum: 90,
    example: 40.7128,
  })
  @IsLatitude()
  latitude!: number;

  @ApiProperty({
    description: 'Longitude of the driver location in decimal degrees.',
    minimum: -180,
    maximum: 180,
    example: -74.006,
  })
  @IsLongitude()
  longitude!: number;

  @ApiPropertyOptional({
    description:
      'When the device captured this position (ISO 8601). Untrusted: used only to reject future, too old, ' +
      'replayed or out-of-order reports; freshness is always measured from the server receive time.',
    example: '2026-10-06T12:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  recordedAt?: string;
}
// Any other field (e.g. a client-computed ETA, an "arrived" flag or a geofence id) is rejected with 400 by
// the global ValidationPipe (forbidNonWhitelisted): derived values are never accepted from a client (#60).
