import { Injectable } from '@nestjs/common';
import {
  BadRequestError,
  CartChange,
  CartChangedError,
  CartWriteConflictError,
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

/** F6 (#205): how often a write that lost a race to another write on the same cart is retried. */
const MAX_WRITE_ATTEMPTS = 50;
/** Checkout validation calls menu-service per item, so it re-runs fewer times. */
const MAX_VALIDATE_ATTEMPTS = 5;

const backoff = (attempt: number) => new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(2 * attempt, 20)));

const cartChangedConcurrently = () => new CartWriteConflictError();

/**
 * Every change to a cart is read → change → compare-and-set write (F6, #205): the write applies only if
 * the cart is still exactly what was read, otherwise the change is re-applied to the newer cart. Two
 * requests at once (a double tap, two devices) both land instead of one overwriting the other.
 */
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

    return this.mutate(userId, (stored) => {
      const cart = stored ?? emptyCart(userId);

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

      return { ...cart, restaurantId: item.restaurantId };
    });
  }

  async updateItemQuantity(
    userId: string,
    menuItemId: string,
    dto: UpdateCartItemDto,
  ): Promise<CartWithTotal> {
    return this.mutate(userId, (stored) => {
      const cart = requireCart(stored);
      const index = cart.items.findIndex((i) => i.menuItemId === menuItemId);
      if (index === -1) {
        throw new BadRequestError(`Item ${menuItemId} is not in the cart`);
      }

      if (dto.quantity === 0) {
        cart.items.splice(index, 1);
      } else {
        cart.items[index].quantity = dto.quantity;
      }
      return cart;
    });
  }

  async removeItem(userId: string, menuItemId: string): Promise<CartWithTotal> {
    return this.mutate(userId, (stored) => {
      const cart = requireCart(stored);
      return { ...cart, items: cart.items.filter((i) => i.menuItemId !== menuItemId) };
    });
  }

  async clearCart(userId: string): Promise<void> {
    await this.cartRepository.delete(userId);
  }

  /**
   * #42: re-reads every item from menu-service right before checkout. Unchanged → the cart, which
   * order-service prices the order from. Changed → the cart is brought up to date (current price and
   * name; unavailable, archived, deleted or foreign items taken out; quantities capped) and
   * CartChangedError lists what changed, so the customer sees the new total before paying it.
   *
   * The correction is written only if the cart didn't change while menu-service was being asked
   * (F6); otherwise the check runs again on the newer cart, so an item added meanwhile isn't lost.
   */
  async validateForCheckout(userId: string): Promise<CartWithTotal> {
    for (let attempt = 1; attempt <= MAX_VALIDATE_ATTEMPTS; attempt++) {
      const result = await this.validateOnce(userId);
      if (result !== 'retry') return result;
      await backoff(attempt);
    }
    throw cartChangedConcurrently();
  }

  private async validateOnce(userId: string): Promise<CartWithTotal | 'retry'> {
    const { cart, version } = await this.cartRepository.read(userId);
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
    const next = toStored({ ...cart, items: kept });
    if (!(await this.cartRepository.replace(userId, version, next))) return 'retry';
    if (changes.length > 0) throw new CartChangedError(changes);
    return withTotal(next ?? emptyCart(userId)); // only names changed: nothing the customer pays differs
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

  /**
   * Applies `change` to the stored cart and writes the result with compare-and-set; when another
   * write got there first, `change` runs again on the newer cart. Errors from `change` (an item from
   * another restaurant, the quantity limit) are final and not retried.
   */
  private async mutate(userId: string, change: (cart: Cart | null) => Cart): Promise<CartWithTotal> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
      const { cart, version } = await this.cartRepository.read(userId);
      const next = toStored(change(cart));
      if (await this.cartRepository.replace(userId, version, next)) {
        return withTotal(next ?? emptyCart(userId));
      }
      await backoff(attempt);
    }
    throw cartChangedConcurrently();
  }
}

function requireCart(cart: Cart | null): Cart {
  if (!cart) {
    throw new BadRequestError('Cart is empty');
  }
  return cart;
}

/** What to store: nothing for an empty cart (its key is deleted), else the cart stamped now. */
function toStored(cart: Cart): Cart | null {
  return cart.items.length === 0 ? null : { ...cart, updatedAt: new Date().toISOString() };
}
