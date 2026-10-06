import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, DeliveryStatus, ForbiddenError, JwtPayload, NotFoundError, UserRole } from '@food-delivery/shared';
import {
  LocationReportRejectedError,
  REJECTION_MESSAGES,
  checkLocationReport,
  positionForDelivery,
} from './location-trust';
import { LocationRepository } from '../repositories/location.repository';
import { DeliveryServiceClient } from '../common/delivery-service.client';
import { DriverServiceClient } from '../common/driver-service.client';
import { TrackingEventsBus } from '../common/tracking-events.bus';
import { UpdateLocationDto } from '../dto/update-location.dto';
import { DriverLocation } from '../entities/location.model';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { TrackingState, isTrackingFinished, resolveTracking } from './tracking-state';
import { DeliveryEta, ETA_ESTIMATOR, EtaEstimator, deriveEta } from './eta';

/** Who is assigned, as delivery-service recorded it (#46). Identity only: never a position. */
export interface DeliveryAssignment {
  driverId: string;
  /** When the claim was accepted; null for deliveries assigned before it was recorded. */
  assignedAt: string | null;
}

export interface DeliveryTrackingInfo {
  deliveryId: string;
  status: string;
  driverId?: string;
  location: DriverLocation | null;
  /** Lifecycle state of this read (#32); see TrackingState. */
  tracking: TrackingState;
  /** Seconds since the driver reported `location`; null when no location is returned. */
  locationAgeSeconds: number | null;
  /** Assignment contract (#46): the current assignment, or null while no driver is assigned. */
  assignment: DeliveryAssignment | null;
  /** ETA contract (#46): derived on this read, never stored; see DeliveryEta. */
  eta: DeliveryEta;
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
    @Inject(ETA_ESTIMATOR) private readonly etaEstimator: EtaEstimator,
  ) {}

  /**
   * Accepts a driver's location report (trust rules: location-trust.ts, #60). The report is bound to the
   * driver's active delivery, resolved by delivery-service from the driver's own token; a driver with
   * no active delivery can't report (409). The client's `recordedAt` can only cause a rejection (422:
   * future, too old, or not newer than the last accepted report). Accepted coordinates are stored as a
   * claim with the server receive time; nothing else in the platform is changed by them.
   */
  async updateLocation(userId: string, dto: UpdateLocationDto, authHeader: string): Promise<DriverLocation> {
    const current = await this.deliveryClient.getCurrentForDriver(authHeader);
    if (!current) {
      this.logger.warn(`tracking.location.rejected driver=${userId} reason=NO_ACTIVE_DELIVERY`);
      throw new ConflictError('Location reports are accepted only while you are on a delivery');
    }
    const now = new Date();
    const rejection = checkLocationReport({
      now,
      recordedAt: dto.recordedAt,
      previous: await this.locationRepository.find(userId),
      deliveryId: current.id,
      maxAgeSeconds: this.config.locationStaleAfterSeconds,
    });
    if (rejection) {
      this.logger.warn(`tracking.location.rejected driver=${userId} delivery=${current.id} reason=${rejection}`);
      throw new LocationReportRejectedError(rejection, REJECTION_MESSAGES[rejection]);
    }

    const location: DriverLocation = {
      userId,
      latitude: dto.latitude,
      longitude: dto.longitude,
      updatedAt: now.toISOString(),
      deliveryId: current.id,
      ...(dto.recordedAt !== undefined ? { recordedAt: new Date(dto.recordedAt).toISOString() } : {}),
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
    return {
      deliveryId,
      status: delivery.status,
      driverId: delivery.driverId,
      assignedAt: delivery.driverId ? (delivery.assignedAt ?? null) : null,
      driverUserId,
    };
  }

  /**
   * Step 2: the tracking read for a known context, reading only the driver's last position from Redis.
   * The realtime stream calls this alone on a driver location report and both steps on delivery changes.
   */
  async snapshot(context: DeliveryTrackingContext, now = new Date()): Promise<DeliveryTrackingInfo> {
    // Only a position reported while the driver was on this delivery counts (#60 session binding).
    const stored = context.driverUserId ? await this.locationRepository.find(context.driverUserId) : null;
    const location = positionForDelivery(stored, context.deliveryId);
    const staleAfter = this.config.locationStaleAfterSeconds;
    const resolved = resolveTracking(context.status, context.driverId, location, now, staleAfter);
    return {
      deliveryId: context.deliveryId,
      status: context.status,
      driverId: context.driverId,
      ...resolved,
      assignment: context.driverId ? { driverId: context.driverId, assignedAt: context.assignedAt } : null,
      eta: deriveEta(context, resolved, this.etaEstimator, now, staleAfter),
    };
  }
}

/** The delivery facts a tracking read depends on; see TrackingService.loadDeliveryContext. */
export interface DeliveryTrackingContext {
  deliveryId: string;
  status: DeliveryStatus;
  driverId?: string;
  /** When the current assignment was accepted (#46); null without a driver. */
  assignedAt: string | null;
  /** User id the current driver reports locations under; null without a driver or once finished. */
  driverUserId: string | null;
}
