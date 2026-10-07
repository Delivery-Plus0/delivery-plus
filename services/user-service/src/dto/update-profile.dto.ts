import { EgyptianMobile } from '@food-delivery/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({
    description: 'Updated full name for the user profile.',
    example: 'Morgan Lee Jr.',
  })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional({
    description: 'Updated Egyptian mobile number (010/011/012/015), any common form; stored as E.164 +201XXXXXXXXX (#152).',
    example: '+201112345678',
  })
  @IsOptional()
  @EgyptianMobile()
  phone?: string;

  @ApiPropertyOptional({
    description: 'Updated address for the profile.',
    example: '10 Main Street, Apt 2B, Brooklyn, NY',
  })
  @IsOptional()
  @IsString()
  address?: string;
}
