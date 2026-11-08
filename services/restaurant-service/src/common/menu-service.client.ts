import { Inject, Injectable } from '@nestjs/common';
import { assertValidUuidV4 } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface MenuReadiness {
  categories: number;
  availableItems: number;
}

/**
 * #208: reads a restaurant's menu from menu-service's public menu route, to check before a submit that
 * there is something for customers to order. Only counts are kept.
 */
@Injectable()
export class MenuServiceClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async menuReadiness(restaurantId: string): Promise<MenuReadiness> {
    const safeId = assertValidUuidV4(restaurantId, 'restaurantId');
    const response = await fetch(`${this.config.menuServiceUrl}/restaurants/${safeId}/menu`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`menu-service menu read failed (status ${response.status})`);
    const menu = (await response.json()) as { categories?: unknown[]; items?: { available?: boolean }[] };
    return {
      categories: Array.isArray(menu.categories) ? menu.categories.length : 0,
      availableItems: Array.isArray(menu.items) ? menu.items.filter((item) => item.available === true).length : 0,
    };
  }
}
