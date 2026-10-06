import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiProduces } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, UserRole } from '@food-delivery/shared';
import { TrackingService } from '../services/tracking.service';
import { TrackingStreamService, TrackingStreamSink, TrackingSubscription } from '../services/tracking-stream.service';
import { UpdateLocationDto } from '../dto/update-location.dto';

@ApiTags('tracking')
@Controller('tracking')
export class TrackingController {
  constructor(
    private readonly trackingService: TrackingService,
    private readonly trackingStream: TrackingStreamService,
  ) {}

  @Post('location')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Report the current driver location' })
  updateLocation(@CurrentUser() user: JwtPayload, @Body() dto: UpdateLocationDto) {
    return this.trackingService.updateLocation(user.sub, dto);
  }

  @Get('driver/:userId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get a driver's last reported location (the driver themself or admin). Customers use /tracking/delivery/:id",
  })
  getDriverLocation(@Param('userId') userId: string, @CurrentUser() user: JwtPayload) {
    return this.trackingService.getDriverLocation(userId, user);
  }

  @Get('delivery/:deliveryId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get combined delivery status + driver location' })
  getDeliveryTracking(
    @Param('deliveryId') deliveryId: string,
    @Headers('authorization') authHeader: string,
  ) {
    return this.trackingService.getDeliveryTracking(deliveryId, authHeader);
  }

  /**
   * Server-Sent Events version of GET delivery/:deliveryId (#135). Same authorization, checked before
   * anything is streamed (403/404 come back as normal JSON errors). Then:
   *   event: tracking  data: <same model as GET>   on open and on every visible change
   *   event: error     data: {statusCode, message} then the stream closes
   *   : ping                                        keepalive every TRACKING_STREAM_HEARTBEAT_MS
   * The stream closes after the ENDED snapshot.
   */
  @Get('delivery/:deliveryId/stream')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiProduces('text/event-stream')
  @ApiOperation({ summary: 'Stream delivery tracking updates (Server-Sent Events)' })
  async streamDeliveryTracking(
    @Param('deliveryId') deliveryId: string,
    @Headers('authorization') authHeader: string,
    @Res() res: Response,
  ): Promise<void> {
    // The client can leave while the subscription is still opening, so `close` may fire before it exists.
    const connection: { subscription?: TrackingSubscription; clientGone: boolean } = { clientGone: false };
    res.on('close', () => {
      connection.clientGone = true;
      void connection.subscription?.close('client_closed');
    });

    const write = (chunk: string) => {
      if (connection.clientGone || res.writableEnded) return;
      if (!res.headersSent) {
        res.status(200).set(SSE_HEADERS);
        res.flushHeaders();
      }
      res.write(chunk);
    };
    const sink: TrackingStreamSink = {
      send: (snapshot) => write(`event: tracking\ndata: ${JSON.stringify(snapshot)}\n\n`),
      heartbeat: () => write(': ping\n\n'),
      fail: (error) => write(`event: error\ndata: ${JSON.stringify(error)}\n\n`),
      close: () => {
        if (!res.writableEnded) res.end();
      },
    };

    // Throws before writing anything when the caller may not read this delivery; the global filter
    // then answers with the usual JSON error.
    connection.subscription = await this.trackingStream.open(deliveryId, authHeader, sink);
    if (connection.clientGone) await connection.subscription.close('client_closed');
  }
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Ask buffering reverse proxies (nginx and friends) to pass events through immediately.
  'X-Accel-Buffering': 'no',
};
