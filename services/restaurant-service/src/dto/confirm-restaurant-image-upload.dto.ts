import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength } from 'class-validator';

export class ConfirmRestaurantImageUploadDto {
  @ApiProperty({ enum: ['cover', 'logo'] })
  @IsIn(['cover', 'logo'])
  imageType!: 'cover' | 'logo';

  @ApiProperty({ example: 'restaurants/<restaurantId>/logo/<uuid>.png' })
  @IsString()
  @MaxLength(512)
  objectKey!: string;
}