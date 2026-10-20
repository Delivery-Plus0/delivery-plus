import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';
import { SessionAppField } from './session.dto';

export class LoginDto extends SessionAppField {
  @ApiProperty({
    description: 'Email address used to authenticate.',
    example: 'customer@example.com',
    format: 'email',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    description: 'Password for the account.',
    example: 'StrongPass123!',
  })
  @IsString()
  password!: string;
}
