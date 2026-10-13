import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RefundPaymentDto {
  @ApiPropertyOptional({ maxLength: 300, description: 'Why support is refunding this payment; kept on the refund record (#56).' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(300)
  reason?: string;
}
