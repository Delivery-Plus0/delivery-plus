import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ORDER_LIST_FILTER_STATUSES, OrderListFilter } from './list-orders-query.dto';
import { OrderStatus } from '@food-delivery/shared';

export class AdminListOrdersQueryDto {
  @ApiPropertyOptional({
    description: 'Page number to fetch, starting at 1.',
    minimum: 1,
    default: 1,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    description: 'Maximum number of orders to return in the page (#212 admin contract: capped at 100).',
    minimum: 1,
    maximum: 100,
    default: 20,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'Free-text search over the order id and the customer id.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: 'Order id to filter to a single order.',
  })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional({
    description: 'Customer id to filter to one customer.',
  })
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({
    description: 'Restaurant id to filter to one restaurant.',
  })
  @IsOptional()
  @IsString()
  restaurantId?: string;

  @ApiPropertyOptional({
    enum: ['active', 'completed', 'cancelled'],
    description: 'Group filter: active = not yet finished, completed = DELIVERED, cancelled = CANCELLED or FAILED.',
  })
  @IsOptional()
  @IsIn(['active', 'completed', 'cancelled'])
  status?: OrderListFilter;

  @ApiPropertyOptional({
    enum: ['createdAt:asc', 'createdAt:desc'],
    default: 'createdAt:desc',
    description: 'Sort order of the results.',
  })
  @IsOptional()
  @IsIn(['createdAt:asc', 'createdAt:desc'])
  sort: 'createdAt:asc' | 'createdAt:desc' = 'createdAt:desc';

  statuses(): OrderStatus[] | null {
    return this.status ? ORDER_LIST_FILTER_STATUSES[this.status] : null;
  }
}
