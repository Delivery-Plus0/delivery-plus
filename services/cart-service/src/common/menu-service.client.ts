import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError, NotFoundError, assertValidUuidV4 } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface MenuItemDetails {
  id: string;
  restaurantId: string;
  name: string;
  price: number;
  available: boolean;
  /** Archived items (#148) are kept for old orders but can never be bought again. */
  archived?: boolean;
}

@Injectable()
export class MenuServiceClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async getItem(menuItemId: string): Promise<MenuItemDetails> {
    const safeMenuItemId = assertValidUuidV4(menuItemId, 'menuItemId');
    const response = await fetch(`${this.config.menuServiceUrl}/menu-items/${safeMenuItemId}`);

    if (response.status === 404) {
      throw new NotFoundError(`Menu item ${safeMenuItemId} not found`);
    }
    if (!response.ok) {
      throw new BadRequestError(`Failed to fetch menu item ${safeMenuItemId}`);
    }

    const body = (await response.json()) as {
      id: string;
      restaurantId: string;
      name: string;
      price: string;
      available: boolean;
      archivedAt?: string | null;
    };
    return {
      id: body.id,
      restaurantId: body.restaurantId,
      name: body.name,
      price: parseFloat(body.price),
      available: body.available,
      archived: Boolean(body.archivedAt),
    };
  }
}
