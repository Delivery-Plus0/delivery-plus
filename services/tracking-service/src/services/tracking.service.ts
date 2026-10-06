import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, JwtPayload, NotFoundError, UserRole } from '@food-delivery/shared';
import { LocationRepository } from '../repositories/location.repository';
import { DeliveryServiceClient } from '../common/delivery-service.client';
import { DriverServiceClient } from '../common/driver-service.client';
import { UpdateLocationDto } from '../dto/update-location.dto';
import { DriverLocation } from '../entities/location.model';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { TrackingState, isTrackingFinished, resolveTracking } from './tracking-state';

export interface DeliveryTrackingInfo {
  deliveryId: string;
  status: string;
  driverId?: string;
  location: DriverLocation | null;
  /** Lifecycle state of this read (#32); see TrackingState. */
  tracking: TrackingState;
  /** Seconds since the driver reported `location`; null when no location is returned. */
  locationAgeSeconds: number | null;
}

@Injectable()
export class TrackingService {
  constructor(
    private readonly locationRepository: LocationRepository,
    private readonly deliveryClient: DeliveryServiceClient,
    private readonly driverClient: DriverServiceClient,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'locationStaleAfterSeconds'>,
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
   *
   * Lifecycle (#32): the delivery's current driverId is the only source of the position, so after a
   * reassignment the previous driver's position is never returned. A finished delivery returns no
   * position at all (ENDED), even while the driver's last report is still in Redis.
   */
  async getDeliveryTracking(deliveryId: string, authHeader: string): Promise<DeliveryTrackingInfo> {
    const delivery = await this.deliveryClient.getDelivery(deliveryId, authHeader);

    let location: DriverLocation | null = null;
    if (delivery.driverId && !isTrackingFinished(delivery.status)) {
      const driver = await this.driverClient.getDriver(delivery.driverId);
      location = await this.locationRepository.find(driver.userId);
    }

    return {
      deliveryId,
      status: delivery.status,
      driverId: delivery.driverId,
      ...resolveTracking(
        delivery.status,
        delivery.driverId,
        location,
        new Date(),
        this.config.locationStaleAfterSeconds,
      ),
    };
  }
}
