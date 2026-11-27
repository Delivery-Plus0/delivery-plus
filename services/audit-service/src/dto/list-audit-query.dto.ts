import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

export const AUDIT_TARGET_TYPES = ['USER', 'DRIVER', 'RESTAURANT', 'ORDER', 'DELIVERY', 'PAYMENT', 'MENU_ITEM', 'STAFF'] as const;

/** `GET /admin/audit` (#213): ADR 002 list contract, newest first. */
export class ListAuditQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'The staff member who acted.', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ enum: AUDIT_TARGET_TYPES })
  @IsOptional()
  @IsIn(AUDIT_TARGET_TYPES)
  targetType?: string;

  @ApiPropertyOptional({ description: 'What was acted on; usually needs targetType too.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  targetId?: string;

  @ApiPropertyOptional({ description: 'A dotted action, e.g. driver.approve.', example: 'driver.approve' })
  @IsOptional()
  @Matches(/^[a-z_]+(\.[a-z_]+)+$/)
  action?: string;

  @ApiPropertyOptional({ description: 'Inclusive, ISO 8601.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ description: 'Exclusive, ISO 8601.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
