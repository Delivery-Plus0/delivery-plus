import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryStatus } from '@food-delivery/shared';

/** The driver actions that move a delivery forward: POST /deliveries/:id/<action>. */
export type DriverDeliveryAction = 'pickup' | 'start' | 'complete';

/** What the assigned driver may do next, by delivery status. Mirrors DELIVERY_TRANSITIONS for the driver's own steps. */
export const NEXT_DRIVER_ACTIONS: Partial<Record<DeliveryStatus, DriverDeliveryAction[]>> = {
  [DeliveryStatus.DRIVER_ASSIGNED]: ['pickup'],
  [DeliveryStatus.PICKED_UP]: ['start'],
  [DeliveryStatus.IN_TRANSIT]: ['complete'],
};

export class PickupDto {
  @ApiProperty() restaurantId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() address!: string;
}

export class DropOffDto {
  @ApiProperty({ nullable: true, type: String, description: 'Null only for orders placed before addresses were stored.' })
  address!: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) notes!: string | null;
  @ApiPropertyOptional({ nullable: true, type: Number }) latitude!: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number }) longitude!: number | null;
}

export class OrderLineDto {
  @ApiProperty() name!: string;
  @ApiProperty() quantity!: number;
}

export class OrderSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: [OrderLineDto] }) items!: OrderLineDto[];
  @ApiProperty({ description: 'Order total as a decimal string, e.g. "19.98".' }) totalAmount!: string;
}

/** GET /deliveries/me/current: everything the assigned driver needs to act, from server-side state only. */
export class DriverCurrentDeliveryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: DeliveryStatus }) status!: DeliveryStatus;
  @ApiProperty() orderId!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ type: PickupDto }) pickup!: PickupDto;
  @ApiProperty({ type: DropOffDto }) dropOff!: DropOffDto;
  @ApiProperty({ type: OrderSummaryDto }) order!: OrderSummaryDto;
  @ApiProperty({ enum: ['pickup', 'start', 'complete'], isArray: true }) nextActions!: DriverDeliveryAction[];
}
