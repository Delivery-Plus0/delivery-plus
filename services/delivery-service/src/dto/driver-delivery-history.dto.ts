import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { DeliveryStatus } from '@food-delivery/shared';
import { OrderLineDto } from './driver-current-delivery.dto';

/** History filters as the driver sees them; each maps to delivery statuses. */
export const HISTORY_FILTERS = ['active', 'completed', 'cancelled'] as const;
export type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export const HISTORY_FILTER_STATUSES: Record<HistoryFilter, DeliveryStatus[]> = {
  active: [DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.PICKED_UP, DeliveryStatus.IN_TRANSIT],
  completed: [DeliveryStatus.DELIVERED],
  cancelled: [DeliveryStatus.CANCELLED],
};

export const HISTORY_MAX_LIMIT = 50;

export class DriverHistoryQueryDto {
  @ApiPropertyOptional({ enum: HISTORY_FILTERS, description: 'Omit for every delivery.' })
  @IsOptional()
  @IsIn(HISTORY_FILTERS)
  status?: HistoryFilter;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: HISTORY_MAX_LIMIT, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(HISTORY_MAX_LIMIT)
  limit: number = 20;
}

export class HistoryRestaurantDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

export class HistoryOrderDto {
  @ApiProperty({ type: [OrderLineDto] }) items!: OrderLineDto[];
  @ApiProperty({ description: 'Order total as a decimal string, e.g. "19.98".' }) totalAmount!: string;
  /** Where it was delivered. Only the address: no customer name, phone, notes or coordinates. */
  @ApiProperty({ nullable: true, type: String }) dropOffAddress!: string | null;
}

/** One past or current delivery of the calling driver (#142). */
export class DriverHistoryItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ enum: DeliveryStatus }) status!: DeliveryStatus;
  @ApiProperty({ nullable: true, type: Date }) assignedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date, description: 'Null for deliveries picked up before stage times were recorded.' })
  pickedUpAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) deliveredAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ nullable: true, type: HistoryRestaurantDto, description: 'Null if restaurant-service could not be reached.' })
  restaurant!: HistoryRestaurantDto | null;
  @ApiProperty({ nullable: true, type: HistoryOrderDto, description: 'Null if order-service could not be reached.' })
  order!: HistoryOrderDto | null;
}

export class DriverHistoryPageDto {
  @ApiProperty({ type: [DriverHistoryItemDto] }) items!: DriverHistoryItemDto[];
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
