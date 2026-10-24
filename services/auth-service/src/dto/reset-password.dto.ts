import { EgyptianMobile } from '@food-delivery/shared';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Egyptian mobile of the account, any common form.', example: '01012345678' })
  @EgyptianMobile()
  phone!: string;

  @ApiProperty({ description: 'The 6-digit code from the text message.', example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be the 6 digits from the text message' })
  code!: string;

  @ApiProperty({ description: 'The new password (same policy as registration).', minLength: 8 })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  newPassword!: string;
}