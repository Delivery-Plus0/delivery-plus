import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** PATCH /drivers/me/vehicle (#147): the driver's own vehicle, only while offline. */
export class UpdateVehicleDto {
  @ApiProperty({ minLength: 2, maxLength: 50, example: 'Scooter' })
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(50)
  vehicleType!: string;

  @ApiProperty({ minLength: 2, maxLength: 20, example: 'ABC-1234' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @MinLength(2)
  @MaxLength(20)
  licensePlate!: string;
}

/** PATCH /drivers/:id/verification (#147, ADMIN only). */
export class UpdateVerificationDto {
  @ApiProperty({ enum: VERIFICATION_STATUSES })
  @IsIn(VERIFICATION_STATUSES)
  status!: VerificationStatus;

  @ApiPropertyOptional({ maxLength: 300, description: 'Shown to the driver, e.g. why the review failed.' })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(300)
  note?: string;
}
