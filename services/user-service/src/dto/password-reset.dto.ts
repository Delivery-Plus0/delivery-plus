import { EgyptianMobile } from '@food-delivery/shared';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class PasswordResetSendDto {
  @ApiProperty({
    description: 'Egyptian mobile (010/011/012/015), any common form; normalized to E.164.',
    example: '01012345678',
  })
  @EgyptianMobile()
  phone!: string;
}

export class PasswordResetVerifyDto {
  @ApiProperty({
    description: 'Egyptian mobile (010/011/012/015), any common form; normalized to E.164.',
    example: '01012345678',
  })
  @EgyptianMobile()
  phone!: string;

  @ApiProperty({ description: 'The 6-digit code from the text message.', example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be the 6 digits from the text message' })
  code!: string;
}