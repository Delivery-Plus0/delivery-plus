import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class ConfirmAvatarUploadDto {
  @ApiProperty({ example: 'users/<userId>/avatar/<uuid>.png' })
  @IsString()
  @MaxLength(512)
  objectKey!: string;
}