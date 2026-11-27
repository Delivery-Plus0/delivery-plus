import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { EgyptianMobile } from '@food-delivery/shared';

const toBoolean = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

export const DIRECTORY_ROLES = ['CUSTOMER', 'DRIVER', 'RESTAURANT_OWNER', 'ADMIN'] as const;

/** `GET /admin/users` (#214). Search by phone or email is `POST /admin/users/search`, never a query string. */
export class AdminListUsersQueryDto {
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

  @ApiPropertyOptional({ enum: DIRECTORY_ROLES })
  @IsOptional()
  @IsIn(DIRECTORY_ROLES)
  role?: (typeof DIRECTORY_ROLES)[number];

  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'SUSPENDED'])
  status?: 'ACTIVE' | 'SUSPENDED';

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(toBoolean)
  @IsIn([true, false])
  emailVerified?: boolean;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(toBoolean)
  @IsIn([true, false])
  phoneVerified?: boolean;

  @ApiPropertyOptional({ description: 'The start of the full name (case-insensitive), at least 2 characters.' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(2)
  @MaxLength(60)
  q?: string;

  @ApiPropertyOptional({ description: 'Accounts created at or after, ISO 8601.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  createdFrom?: string;

  @ApiPropertyOptional({ description: 'Accounts created before, ISO 8601.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  createdTo?: string;
}

/**
 * `POST /admin/users/search` (#214, #217 decision): one exact value in the body, so it never lands in
 * a URL or an access log. The phone is normalized to E.164 and the email lowercased first.
 */
export class AdminSearchUsersDto {
  @ApiPropertyOptional({ example: '01012345678' })
  @IsOptional()
  @EgyptianMobile()
  phone?: string;

  @ApiPropertyOptional({ example: 'customer@example.com' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(320)
  email?: string;
}
