import { EgyptianMobile, UserRole } from '@food-delivery/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Roles a caller may choose for themselves at public registration. An allow-list, so a role added
 * to `UserRole` later is not self-assignable until someone decides it should be. ADMIN is never on
 * it: admin accounts are provisioned outside public registration.
 */
export const SELF_SERVICE_ROLES: readonly UserRole[] = [
  UserRole.CUSTOMER,
  UserRole.RESTAURANT_OWNER,
  UserRole.DRIVER,
];

export class RegisterDto {
  @ApiProperty({
    description: 'Email address for the new account.',
    example: 'customer@example.com',
    format: 'email',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    description: 'Password for the account. Minimum 8 characters.',
    minLength: 8,
    example: 'StrongPass123!',
  })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password!: string;

  @ApiProperty({
    description: 'Display name for the user profile.',
    example: 'Jane Customer',
  })
  @IsString()
  fullName!: string;

  @ApiPropertyOptional({
    description: 'Optional Egyptian mobile number (010/011/012/015), any common form; stored as E.164 +201XXXXXXXXX (#152).',
    example: '+201012345678',
  })
  @IsOptional()
  @EgyptianMobile()
  phone?: string;

  @ApiPropertyOptional({
    description: 'Account type to register as. Defaults to CUSTOMER when omitted. ADMIN cannot be self-assigned.',
    enum: SELF_SERVICE_ROLES,
    example: UserRole.CUSTOMER,
  })
  @IsOptional()
  @IsIn(SELF_SERVICE_ROLES, { message: `role must be one of ${SELF_SERVICE_ROLES.join(', ')}` })
  role?: UserRole;
}
