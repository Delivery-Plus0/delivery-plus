import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser, JwtPayload, RateLimitGuard, RateLimit } from '@food-delivery/shared';
import { CartService } from '../services/cart.service';
import { AddCartItemDto } from '../dto/add-cart-item.dto';
import { UpdateCartItemDto } from '../dto/update-cart-item.dto';

@ApiTags('cart')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RateLimitGuard)
@RateLimit({ limit: 30, windowSeconds: 60 })
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  @ApiOperation({ summary: 'Get the current user cart with computed total' })
  getCart(@CurrentUser() user: JwtPayload) {
    return this.cartService.getCart(user.sub);
  }

  @Post('items')
  @ApiOperation({ summary: 'Add an item to the cart' })
  addItem(@CurrentUser() user: JwtPayload, @Body() dto: AddCartItemDto) {
    return this.cartService.addItem(user.sub, dto);
  }

  @Patch('items/:menuItemId')
  @ApiOperation({ summary: 'Update the quantity of an item (0 removes it)' })
  updateItem(
    @CurrentUser() user: JwtPayload,
    @Param('menuItemId') menuItemId: string,
    @Body() dto: UpdateCartItemDto,
  ) {
    return this.cartService.updateItemQuantity(user.sub, menuItemId, dto);
  }

  @Delete('items/:menuItemId')
  @ApiOperation({ summary: 'Remove an item from the cart' })
  removeItem(@CurrentUser() user: JwtPayload, @Param('menuItemId') menuItemId: string) {
    return this.cartService.removeItem(user.sub, menuItemId);
  }

  @Post('validate')
  @ApiOperation({
    summary: 'Re-check the cart against the menu before checkout (#42)',
    description:
      'Returns the cart when every item still exists, is available and has the same price. Otherwise the cart is ' +
      'brought up to date (current prices; unavailable or removed items taken out; quantities capped) and the ' +
      'answer is 409 CartChanged with details.changes listing what changed.',
  })
  validate(@CurrentUser() user: JwtPayload) {
    return this.cartService.validateForCheckout(user.sub);
  }

  @Delete()
  @ApiOperation({ summary: 'Clear the cart' })
  clearCart(@CurrentUser() user: JwtPayload) {
    return this.cartService.clearCart(user.sub);
  }
}
