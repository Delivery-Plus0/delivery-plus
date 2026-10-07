import { EgyptianMobile } from '@food-delivery/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateProfileDto {
  @ApiProperty({
    description: 'UUID of the user account this profile belongs to.',
    format: 'uuid',
    example: '9df9a9b2-1b3d-4f0b-8e6a-3f1f04e2cb77',
  })
  @IsUUID()
  userId!: string;

  @ApiProperty({
    description: 'Auth-service credential UUID this profile maps to. Must equal userId.',
    format: 'uuid',
    example: '9df9a9b2-1b3d-4f0b-8e6a-3f1f04e2cb77',
  })
  @IsUUID()
  authCredentialId!: string;

  @ApiProperty({
    description: 'Primary email address for the profile.',
    format: 'email',
    example: 'profile@example.com',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    description: 'Full display name for the user profile.',
    example: 'Morgan Lee',
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
}
