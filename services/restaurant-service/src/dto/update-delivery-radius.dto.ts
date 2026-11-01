import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, Max, Min } from 'class-validator';

export class UpdateDeliveryRadiusDto {
  @ApiProperty({ minimum: 0.01, maximum: 50, example: 5 })
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(50)
  deliveryRadiusKm!: number;
}
