import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { JwtAuthGuard, Roles, RolesGuard, UserRole } from '@food-delivery/shared';
import { EarningsService } from '../services/earnings.service';
import { RatingsService } from '../services/ratings.service';

export const DRIVER_SUMMARY_CALLER = 'system:driver-service';

export interface StaffDriverSummary {
  earnings: { currency: 'EGP'; pending: string; available: string; balance: string };
  rating: { average: number | null; count: number };
}

/**
 * Internal only: `/internal/...` is never reached through the gateway, and SYSTEM tokens are refused
 * on gateway requests. driver-service's staff driver page (#214) reads the ledger balance and the
 * rating here, the data delivery-service owns.
 */
@ApiExcludeController()
@Controller('internal/deliveries')
export class InternalDriversController {
  constructor(
    private readonly earnings: EarningsService,
    private readonly ratings: RatingsService,
  ) {}

  @Get('drivers/:driverId/summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SYSTEM)
  async summary(
    @Param('driverId', new ParseUUIDPipe()) driverId: string,
    @Req() request: { user?: { sub?: string } },
  ): Promise<StaffDriverSummary> {
    if (request.user?.sub !== DRIVER_SUMMARY_CALLER) throw new ForbiddenException('Only driver-service reads driver summaries');
    const [earnings, rating] = await Promise.all([this.earnings.totalsForStaff(driverId), this.ratings.summaryForStaff(driverId)]);
    return { earnings, rating };
  }
}
