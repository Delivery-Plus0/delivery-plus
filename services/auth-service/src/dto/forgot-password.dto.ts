import { EgyptianMobile } from '@food-delivery/shared';
import { ApiProperty } from '@nestjs/swagger';

export class ForgotPasswordDto {
  @ApiProperty({ description: 'Egyptian mobile of the account, any common form.', example: '01012345678' })
  @EgyptianMobile()
  phone!: string;
}