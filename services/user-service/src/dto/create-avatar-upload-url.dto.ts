import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class CreateAvatarUploadUrlDto {
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'image/webp'] })
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  contentType!: string;
}