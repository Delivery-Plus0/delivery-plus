import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class ConfirmItemImageUploadDto {
  @ApiProperty({ example: 'restaurants/<restaurantId>/menu-items/<itemId>/<uuid>.png' })
  @IsString()
  @MaxLength(512)
  objectKey!: string;
}