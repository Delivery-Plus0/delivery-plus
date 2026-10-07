import { EgyptianMobile } from '@food-delivery/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class StartPhoneVerificationDto {
  @ApiPropertyOptional({
    description:
      'A new Egyptian mobile to verify (a phone change); it becomes the profile phone only once the code is confirmed. Without it, the current profile phone gets the code.',
    example: '01012345678',
  })
  @IsOptional()
  @EgyptianMobile()
  phone?: string;
}

export class VerifyPhoneDto {
  @ApiProperty({ description: 'The 6-digit code from the text message.', example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be the 6 digits from the text message' })
  code!: string;
}
