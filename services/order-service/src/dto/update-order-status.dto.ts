import { OrderStatus } from '@food-delivery/shared';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CANCELLATION_REASON_MAX } from '../common/order-outcome';

export class UpdateOrderStatusDto {
  @ApiProperty({
    description: 'The next status to assign to the order.',
    enum: OrderStatus,
    example: OrderStatus.CREATED,
  })
  @IsEnum(OrderStatus)
  status!: OrderStatus;

  @ApiPropertyOptional({
    maxLength: CANCELLATION_REASON_MAX,
    description:
      'Only with status CANCELLED, from a restaurant owner or admin: shown to the customer after a fixed lead-in (#143). Ignored for customers, whose reason is always "You cancelled this order."',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(CANCELLATION_REASON_MAX)
  reason?: string;
}
