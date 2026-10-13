import { Injectable } from '@nestjs/common';
import {
  BadRequestError,
  CartChange,
  CartChangedError,
  ConflictError,
  MAX_CART_ITEM_QUANTITY,
  NotFoundError,
} from '@food-delivery/shared';
import { CartRepository } from '../repositories/cart.repository';
import { MenuItemDetails, MenuServiceClient } from '../common/menu-service.client';
import { AddCartItemDto } from '../dto/add-cart-item.dto';
import { UpdateCartItemDto } from '../dto/update-cart-item.dto';
import { Cart, CartItem, CartWithTotal, emptyCart, withTotal } from '../entities/cart.model';

/** Prices compared in whole piasters, so 12.5 and 12.50 are the same price. */
const toPiasters = (price: number) => Math.round(price * 100);

@Injectable()
export class CartService {
  constructor(
    private readonly cartRepository: CartRepository,
    private readonly menuServiceClient: MenuServiceClient,
  ) {}

  async getCart(userId: string): Promise<CartWithTotal> {
    const cart = (await this.cartRepository.find(userId)) ?? emptyCart(userId);
    return withTotal(cart);
  }

  async addItem(userId: string, dto: AddCartItemDto): Promise<CartWithTotal> {
    const item = await this.menuServiceClient.getItem(dto.menuItemId);

    if (!item.available) {
      throw new BadRequestError(`Menu item ${item.name} is not currently available`);
    }

    let cart = (await this.cartRepository.find(userId)) ?? emptyCart(userId);

    if (cart.items.length > 0 && cart.restaurantId && cart.restaurantId !== item.restaurantId) {
      throw new ConflictError(
        'Cart already contains items from a different restaurant. Clear the cart first.',
      );
    }

    const existing = cart.items.find((i) => i.menuItemId === dto.menuItemId);
    if (existing && existing.quantity + dto.quantity > MAX_CART_ITEM_QUANTITY) {
      throw new BadRequestError(`You can order at most ${MAX_CART_ITEM_QUANTITY} of one item`);
    }
    if (existing) {
      existing.quantity += dto.quantity;
    } else {
      cart.items.push({
        menuItemId: item.id,
        name: item.name,
        price: item.price,
        quantity: dto.quantity,
      });
    }

    cart = { ...cart, restaurantId: item.restaurantId, updatedAt: new Date().toISOString() };
    await this.cartRepository.save(cart);
    return withTotal(cart);
  }

  async updateItemQuantity(
    userId: string,
    menuItemId: string,
    dto: UpdateCartItemDto,
  ): Promise<CartWithTotal> {
    const cart = await this.requireCart(userId);
    const index = cart.items.findIndex((i) => i.menuItemId === menuItemId);
    if (index === -1) {
      throw new BadRequestError(`Item ${menuItemId} is not in the cart`);
    }

    if (dto.quantity === 0) {
      cart.items.splice(index, 1);
    } else {
      cart.items[index].quantity = dto.quantity;
    }

    return this.persistOrClear(cart);
  }

  async removeItem(userId: string, menuItemId: string): Promise<CartWithTotal> {
    const cart = await this.requireCart(userId);
    cart.items = cart.items.filter((i) => i.menuItemId !== menuItemId);
    return this.persistOrClear(cart);
  }

  async clearCart(userId: string): Promise<void> {
    await this.cartRepository.delete(userId);
  }

  /**
   * #42: re-reads every item from menu-service right before checkout. Unchanged → the cart, which
   * order-service prices the order from. Changed → the cart is brought up to date (current price and
   * name; unavailable, archived, deleted or foreign items taken out; quantities capped) and
   * CartChangedError lists what changed, so the customer sees the new total before paying it.
   */
  async validateForCheckout(userId: string): Promise<CartWithTotal> {
    const cart = await this.cartRepository.find(userId);
    if (!cart || cart.items.length === 0) return withTotal(cart ?? emptyCart(userId));

    const changes: CartChange[] = [];
    const kept: CartItem[] = [];
    let refreshed = false;
    for (const item of cart.items) {
      const current = await this.currentMenuItem(item.menuItemId);
      if (!current || current.archived || current.restaurantId !== cart.restaurantId) {
        changes.push({ menuItemId: item.menuItemId, name: item.name, change: 'REMOVED' });
        continue;
      }
      if (!current.available) {
        changes.push({ menuItemId: item.menuItemId, name: current.name, change: 'UNAVAILABLE' });
        continue;
      }
      const next: CartItem = { ...item, name: current.name, price: current.price };
      if (toPiasters(current.price) !== toPiasters(item.price)) {
        changes.push({ menuItemId: item.menuItemId, name: current.name, change: 'PRICE_CHANGED', previousPrice: item.price, currentPrice: current.price });
      }
      if (item.quantity > MAX_CART_ITEM_QUANTITY) {
        next.quantity = MAX_CART_ITEM_QUANTITY;
        changes.push({ menuItemId: item.menuItemId, name: current.name, change: 'QUANTITY_LIMITED', previousQuantity: item.quantity, currentQuantity: MAX_CART_ITEM_QUANTITY });
      }
      if (next.name !== item.name) refreshed = true;
      kept.push(next);
    }

    if (changes.length === 0 && !refreshed) return withTotal(cart);
    const updated = await this.persistOrClear({ ...cart, items: kept });
    if (changes.length > 0) throw new CartChangedError(changes);
    return updated; // only names changed: nothing the customer pays differs
  }

  /** The item as menu-service has it now, or null when it no longer exists. */
  private async currentMenuItem(menuItemId: string): Promise<MenuItemDetails | null> {
    try {
      return await this.menuServiceClient.getItem(menuItemId);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  private async requireCart(userId: string): Promise<Cart> {
    const cart = await this.cartRepository.find(userId);
    if (!cart) {
      throw new BadRequestError('Cart is empty');
    }
    return cart;
  }

  private async persistOrClear(cart: Cart): Promise<CartWithTotal> {
    if (cart.items.length === 0) {
      await this.cartRepository.delete(cart.userId);
      const empty = emptyCart(cart.userId);
      return withTotal(empty);
    }

    const updated = { ...cart, updatedAt: new Date().toISOString() };
    await this.cartRepository.save(updated);
    return withTotal(updated);
  }
}
