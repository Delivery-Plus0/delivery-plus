import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError, CartChange, CartChangedError } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface CartItemDto {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
}

export interface CartDto {
  userId: string;
  restaurantId: string | null;
  items: CartItemDto[];
  total: number;
}

/**
 * Forwards the customer's own Authorization header to cart-service rather
 * than using an internal/service token, since these calls happen on behalf
 * of the authenticated customer placing the order.
 */
@Injectable()
export class CartServiceClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async getCart(authHeader: string): Promise<CartDto> {
    const response = await fetch(`${this.config.cartServiceUrl}/cart`, {
      headers: { Authorization: authHeader },
    });

    if (!response.ok) {
      throw new BadRequestError(`Failed to read cart (status ${response.status})`);
    }

    return (await response.json()) as CartDto;
  }

  /**
   * #42: the cart re-checked against the menu right now. 409 CartChanged (cart-service already
   * brought the cart up to date) is passed on to the customer with its list of changes.
   */
  async getValidatedCart(authHeader: string): Promise<CartDto> {
    const response = await fetch(`${this.config.cartServiceUrl}/cart/validate`, {
      method: 'POST',
      headers: { Authorization: authHeader },
    });

    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string; details?: { changes?: CartChange[] } };
      if (body.error === 'CartChanged') {
        throw new CartChangedError(body.details?.changes ?? [], body.message);
      }
    }
    if (!response.ok) {
      throw new BadRequestError(`Failed to check the cart (status ${response.status})`);
    }

    return (await response.json()) as CartDto;
  }

  async clearCart(authHeader: string): Promise<void> {
    const response = await fetch(`${this.config.cartServiceUrl}/cart`, {
      method: 'DELETE',
      headers: { Authorization: authHeader },
    });

    if (!response.ok) {
      throw new BadRequestError(`Failed to clear cart (status ${response.status})`);
    }
  }
}
