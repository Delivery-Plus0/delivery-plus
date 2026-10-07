import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsPositive } from 'class-validator';
import { OrderStatus } from '@food-delivery/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListOrdersQueryDto {
  @ApiPropertyOptional({
    description: 'Page number to fetch, starting at 1.',
    minimum: 1,
    default: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsPositive()
  page: number = 1;

  @ApiPropertyOptional({
    description: 'Maximum number of orders to return in the page.',
    minimum: 1,
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsPositive()
  limit: number = 20;

  @ApiPropertyOptional({
    enum: ['active', 'completed', 'cancelled'],
    description: 'Group filter (#143): active = not yet finished, completed = DELIVERED, cancelled = CANCELLED or FAILED.',
  })
  @IsOptional()
  @IsIn(['active', 'completed', 'cancelled'])
  status?: OrderListFilter;
}

export type OrderListFilter = 'active' | 'completed' | 'cancelled';

export const ORDER_LIST_FILTER_STATUSES: Record<OrderListFilter, OrderStatus[]> = {
  active: [
    OrderStatus.CREATED,
    OrderStatus.PAYMENT_PENDING,
    OrderStatus.CONFIRMED,
    OrderStatus.PREPARING,
    OrderStatus.READY_FOR_PICKUP,
    OrderStatus.DRIVER_ASSIGNED,
    OrderStatus.PICKED_UP,
  ],
  completed: [OrderStatus.DELIVERED],
  cancelled: [OrderStatus.CANCELLED, OrderStatus.FAILED],
};
