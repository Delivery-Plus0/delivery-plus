import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { UserRole } from '@food-delivery/shared';

/** #214: user-service's query for the staff people directory (internal, SYSTEM). */
export class AccountQueryDto {
  /** A set user-service already matched on profile fields (name, phone verified). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  ids?: string[];

  @IsOptional()
  @IsArray()
  @IsEnum(UserRole, { each: true })
  roles?: UserRole[];

  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status?: 'ACTIVE' | 'SUSPENDED';

  @IsOptional()
  @IsBoolean()
  emailVerified?: boolean;

  @IsOptional()
  @IsISO8601({ strict: true })
  createdFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  createdTo?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit: number = 20;
}
