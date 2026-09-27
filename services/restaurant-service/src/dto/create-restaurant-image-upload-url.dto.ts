import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class CreateRestaurantImageUploadUrlDto {
  @ApiProperty({ enum: ['cover', 'logo'] })
  @IsIn(['cover', 'logo'])
  imageType!: 'cover' | 'logo';

  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'image/webp'] })
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  contentType!: string;
}