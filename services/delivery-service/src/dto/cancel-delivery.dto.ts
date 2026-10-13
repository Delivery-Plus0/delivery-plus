import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelDeliveryDto {
  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Why the platform cancelled; shown to the customer after "Delivery Plus cancelled this order:" (#53).',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(200)
  reason?: string;
}
