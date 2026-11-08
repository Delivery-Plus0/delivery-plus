import { Injectable, Logger } from '@nestjs/common';
import { DeliveryStatus } from '@food-delivery/shared';
import { DriverServiceClient } from '../common/driver-service.client';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import { UserServiceClient } from '../common/user-service.client';
import { ContactRevealsRepository } from '../repositories/contact-reveals.repository';
import { ContactField } from '../entities/delivery-contact-reveal.entity';

/**
 * #211 (owner decision: direct numbers for the pilot). A delivery's participants can reach each other
 * while it is active: from the driver's assignment until it is delivered or cancelled. Before and after
 * that window no number is ever returned, history included. Every reveal is recorded (who, which field,
 * when) without the number; masked calling can later return a proxy number in the same fields.
 */
export const CONTACT_WINDOW: readonly DeliveryStatus[] = [DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.PICKED_UP, DeliveryStatus.IN_TRANSIT];

export interface DriverContacts {
  customerPhone: string | null;
  restaurantPhone: string | null;
}

@Injectable()
export class DeliveryContactService {
  private readonly logger = new Logger(DeliveryContactService.name);

  constructor(
    private readonly users: UserServiceClient,
    private readonly restaurants: RestaurantServiceClient,
    private readonly drivers: DriverServiceClient,
    private readonly reveals: ContactRevealsRepository,
  ) {}

  /** For the delivery's assigned driver: the customer's and the restaurant's phones. */
  async forDriver(
    delivery: { id: string; status: DeliveryStatus },
    parties: { customerId: string; restaurantId: string },
    viewerUserId: string,
  ): Promise<DriverContacts> {
    if (!CONTACT_WINDOW.includes(delivery.status)) return { customerPhone: null, restaurantPhone: null };
    const [customerPhone, restaurantPhone] = await Promise.all([
      this.lookup('customer', () => this.users.getProfile(parties.customerId).then((profile) => profile.phone ?? null)),
      this.lookup('restaurant', () => this.restaurants.getContact(parties.restaurantId).then((contact) => contact.contactPhone ?? null)),
    ]);
    const recorded = await this.record(delivery.id, viewerUserId, 'DRIVER', [
      ...(customerPhone ? (['customerPhone'] as const) : []),
      ...(restaurantPhone ? (['restaurantPhone'] as const) : []),
    ]);
    return recorded ? { customerPhone, restaurantPhone } : { customerPhone: null, restaurantPhone: null };
  }

  /** For the order's customer: the assigned driver's phone. */
  async forCustomer(delivery: { id: string; status: DeliveryStatus; driverId?: string | null }, viewerUserId: string): Promise<string | null> {
    if (!CONTACT_WINDOW.includes(delivery.status) || !delivery.driverId) return null;
    const driverId = delivery.driverId;
    const driverPhone = await this.lookup('driver', async () => {
      const driver = await this.drivers.getDriver(driverId);
      return (await this.users.getProfile(driver.userId)).phone ?? null;
    });
    if (!driverPhone) return null;
    return (await this.record(delivery.id, viewerUserId, 'CUSTOMER', ['driverPhone'])) ? driverPhone : null;
  }

  /** A number that can't be read now is null: contact details never fail the delivery read. */
  private async lookup(party: string, read: () => Promise<string | null>): Promise<string | null> {
    try {
      return await read();
    } catch (error) {
      this.logger.warn(`delivery.contact.unavailable party=${party}: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * The record is written before the numbers are returned. If it can't be written the read still
   * succeeds without them, so a number is never shown without its record.
   */
  private async record(deliveryId: string, viewerUserId: string, viewerRole: string, fields: ContactField[]): Promise<boolean> {
    try {
      await this.reveals.record(deliveryId, viewerUserId, viewerRole, fields);
      return true;
    } catch (error) {
      this.logger.error(`delivery.contact.record_failed delivery=${deliveryId}: ${(error as Error).message}`);
      return false;
    }
  }
}
