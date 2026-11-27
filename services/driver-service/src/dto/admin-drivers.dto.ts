import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DriverStatus } from '@food-delivery/shared';

/** `GET /admin/drivers` (#214), the ADR 002 list contract. */
export class AdminListDriversQueryDto {
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

  @ApiPropertyOptional({ enum: DriverStatus })
  @IsOptional()
  @IsEnum(DriverStatus)
  status?: DriverStatus;

  @ApiPropertyOptional({ enum: ['PENDING', 'VERIFIED', 'REJECTED'] })
  @IsOptional()
  @IsIn(['PENDING', 'VERIFIED', 'REJECTED'])
  verificationStatus?: 'PENDING' | 'VERIFIED' | 'REJECTED';

  @ApiPropertyOptional({ description: 'Drivers whose driving or vehicle licence ends within this many days (0 = already expired or today).', minimum: 0, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  licenceExpiringWithinDays?: number;

  @ApiPropertyOptional({ description: 'The start of the licence plate, any case.' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @MinLength(1)
  @MaxLength(20)
  @Matches(/^[\p{L}\p{N} -]+$/u, { message: 'q is the start of a licence plate' })
  q?: string;
}

/** `GET /admin/drivers/queue` (#214): submitted applications waiting for a decision, oldest first. */
export class AdminDriverQueueQueryDto {
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
