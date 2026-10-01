import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsLatitude, IsLongitude, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * Optional checkout details. Without `deliveryAddress`, the customer's profile address is used.
 * Either way the address is copied onto the order, so later profile edits don't move a placed order.
 */
export class CreateOrderDto {
  @ApiPropertyOptional({
    description: "Drop-off address for this order. Defaults to the customer's profile address when omitted.",
    maxLength: 500,
    example: '742 Evergreen Terrace, Apt 3B',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  deliveryAddress?: string;

  @ApiPropertyOptional({ description: 'Instructions for the driver (gate code, floor, …).', maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  deliveryNotes?: string;

  @ApiPropertyOptional({ description: 'Drop-off latitude. Requires deliveryAddress and deliveryLongitude.', example: 30.0444 })
  @ValidateIf((dto: CreateOrderDto) => dto.deliveryLatitude !== undefined || dto.deliveryLongitude !== undefined)
  @IsLatitude({ message: 'deliveryLatitude must be a latitude and is required together with deliveryLongitude' })
  deliveryLatitude?: number;

  @ApiPropertyOptional({ description: 'Drop-off longitude. Requires deliveryAddress and deliveryLatitude.', example: 31.2357 })
  @ValidateIf((dto: CreateOrderDto) => dto.deliveryLatitude !== undefined || dto.deliveryLongitude !== undefined)
  @IsLongitude({ message: 'deliveryLongitude must be a longitude and is required together with deliveryLatitude' })
  deliveryLongitude?: number;
}
