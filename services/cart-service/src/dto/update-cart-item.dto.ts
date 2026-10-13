import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { MAX_CART_ITEM_QUANTITY } from '@food-delivery/shared';

export class UpdateCartItemDto {
  @ApiProperty({
    description: 'Updated quantity for the cart item. Set to 0 to remove the item.',
    minimum: 0,
    maximum: MAX_CART_ITEM_QUANTITY,
    example: 0,
  })
  @IsInt()
  @Min(0)
  @Max(MAX_CART_ITEM_QUANTITY)
  quantity!: number; // 0 removes the item
}
