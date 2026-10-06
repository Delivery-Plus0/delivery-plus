import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeliveryStatus, ForbiddenError, JwtPayload, NotFoundError, UserRole } from '@food-delivery/shared';
import { LocationRepository } from '../repositories/location.repository';
import { DeliveryServiceClient } from '../common/delivery-service.client';
import { DriverServiceClient } from '../common/driver-service.client';
import { TrackingEventsBus } from '../common/tracking-events.bus';
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
  private readonly logger = new Logger(TrackingService.name);

  constructor(
    private readonly locationRepository: LocationRepository,
    private readonly deliveryClient: DeliveryServiceClient,
    private readonly driverClient: DriverServiceClient,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'locationStaleAfterSeconds'>,
    private readonly events: TrackingEventsBus,
  ) {}

  async updateLocation(userId: string, dto: UpdateLocationDto): Promise<DriverLocation> {
    const location: DriverLocation = {
      userId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      updatedAt: new Date().toISOString(),
    };
    await this.locationRepository.save(location);
    // Wake realtime subscribers of this driver's delivery (#135). The stored location stays the only
    // source of truth: the message carries no position, and a lost message is caught by the resync.
    await this.events.publishDriverLocation(userId).catch((error: Error) =>
      this.logger.warn(`tracking.push.publish_failed driver location trigger not published: ${error.message}`),
    );
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
    return this.snapshot(await this.loadDeliveryContext(deliveryId, authHeader));
  }

  /**
   * Step 1 of a tracking read: the delivery as the caller may see it (delivery-service authorizes with
   * the caller's token, so this throws Forbidden/NotFound for anyone else) plus the user id its current
   * driver reports locations under. Finished deliveries skip the driver lookup.
   */
  async loadDeliveryContext(deliveryId: string, authHeader: string): Promise<DeliveryTrackingContext> {
    const delivery = await this.deliveryClient.getDelivery(deliveryId, authHeader);
    let driverUserId: string | null = null;
    if (delivery.driverId && !isTrackingFinished(delivery.status)) {
      driverUserId = (await this.driverClient.getDriver(delivery.driverId)).userId;
    }
    return { deliveryId, status: delivery.status, driverId: delivery.driverId, driverUserId };
  }

  /**
   * Step 2: the tracking read for a known context, reading only the driver's last position from Redis.
   * The realtime stream calls this alone on a driver location report and both steps on delivery changes.
   */
  async snapshot(context: DeliveryTrackingContext, now = new Date()): Promise<DeliveryTrackingInfo> {
    const location = context.driverUserId ? await this.locationRepository.find(context.driverUserId) : null;
    return {
      deliveryId: context.deliveryId,
      status: context.status,
      driverId: context.driverId,
      ...resolveTracking(context.status, context.driverId, location, now, this.config.locationStaleAfterSeconds),
    };
  }
}

/** The delivery facts a tracking read depends on; see TrackingService.loadDeliveryContext. */
export interface DeliveryTrackingContext {
  deliveryId: string;
  status: DeliveryStatus;
  driverId?: string;
  /** User id the current driver reports locations under; null without a driver or once finished. */
  driverUserId: string | null;
}
