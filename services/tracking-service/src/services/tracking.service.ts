import { Injectable } from '@nestjs/common';
import { ForbiddenError, JwtPayload, NotFoundError, UserRole } from '@food-delivery/shared';
import { LocationRepository } from '../repositories/location.repository';
import { DeliveryServiceClient } from '../common/delivery-service.client';
import { DriverServiceClient } from '../common/driver-service.client';
import { UpdateLocationDto } from '../dto/update-location.dto';
import { DriverLocation } from '../entities/location.model';

export interface DeliveryTrackingInfo {
  deliveryId: string;
  status: string;
  driverId?: string;
  location: DriverLocation | null;
}

@Injectable()
export class TrackingService {
  constructor(
    private readonly locationRepository: LocationRepository,
    private readonly deliveryClient: DeliveryServiceClient,
    private readonly driverClient: DriverServiceClient,
  ) {}

  async updateLocation(userId: string, dto: UpdateLocationDto): Promise<DriverLocation> {
    const location: DriverLocation = {
      userId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      updatedAt: new Date().toISOString(),
    };
    await this.locationRepository.save(location);
    return location;
  }

  /**
   * A raw driver location is only for that driver and admins. Customers reach a location through
   * getDeliveryTracking, where delivery-service checks they own the order being delivered.
   */
  async getDriverLocation(userId: string, requester: Pick<JwtPayload, 'sub' | 'role'>): Promise<DriverLocation> {
    if (requester.role !== UserRole.ADMIN && requester.sub !== userId) {
      throw new ForbiddenError("You can only read your own location");
    }
    const location = await this.locationRepository.find(userId);
    if (!location) {
      throw new NotFoundError(`No location reported yet for driver ${userId}`);
    }
    return location;
  }

  /**
   * Combines delivery status (delivery-service) with the assigned driver's
   * most recent location (this service's own Redis store), resolving the
   * driver-service Driver.id -> userId mapping along the way since location
   * is keyed by userId (the value drivers actually have on their JWT when
   * posting updates).
   */
  async getDeliveryTracking(deliveryId: string, authHeader: string): Promise<DeliveryTrackingInfo> {
    const delivery = await this.deliveryClient.getDelivery(deliveryId, authHeader);

    if (!delivery.driverId) {
      return { deliveryId, status: delivery.status, driverId: undefined, location: null };
    }

    const driver = await this.driverClient.getDriver(delivery.driverId);
    const location = await this.locationRepository.find(driver.userId);

    return {
      deliveryId,
      status: delivery.status,
      driverId: delivery.driverId,
      location,
    };
  }
}
