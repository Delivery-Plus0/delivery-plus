import { EventEmitter } from 'events';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Response } from 'express';
import { ForbiddenError, JwtAuthGuard, ROLES_KEY, RolesGuard, UserRole } from '@food-delivery/shared';
import { TrackingController } from './tracking.controller';
import { TrackingService } from '../services/tracking.service';
import { TrackingStreamService, TrackingStreamSink } from '../services/tracking-stream.service';

describe('TrackingController', () => {
  const handler = (name: keyof TrackingController) => TrackingController.prototype[name];

  it('no longer exposes driver locations publicly: JWT + role guard on GET /tracking/driver/:userId', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('getDriverLocation'))).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, handler('getDriverLocation'))).toEqual([UserRole.DRIVER, UserRole.ADMIN]);
  });

  it('requires a JWT for delivery tracking (ownership is enforced by delivery-service)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('getDeliveryTracking'))).toContain(JwtAuthGuard);
  });

  it('requires a JWT for the realtime stream too: an anonymous client never reaches it (#135)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('streamDeliveryTracking'))).toEqual([JwtAuthGuard]);
  });

  describe('streamDeliveryTracking (Server-Sent Events)', () => {
    /** Minimal Express response: records status, headers and body; `close` simulates the client leaving. */
    function fakeResponse() {
      const res = Object.assign(new EventEmitter(), {
        statusCode: 0,
        headers: {} as Record<string, string>,
        body: '',
        headersSent: false,
        writableEnded: false,
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        set(headers: Record<string, string>) {
          Object.assign(res.headers, headers);
          return res;
        },
        flushHeaders() {
          res.headersSent = true;
        },
        write(chunk: string) {
          res.body += chunk;
          return true;
        },
        end() {
          res.writableEnded = true;
        },
      });
      return res;
    }

    const snapshot = { deliveryId: 'd-1', status: 'IN_TRANSIT', driverId: 'driver-1', location: null, tracking: 'AWAITING_LOCATION', locationAgeSeconds: null };

    it('writes SSE events with streaming headers, and closes the subscription when the client leaves', async () => {
      const close = jest.fn(async () => undefined);
      const stream = {
        open: jest.fn(async (_id: string, _auth: string, sink: TrackingStreamSink) => {
          sink.send(snapshot as never);
          sink.heartbeat();
          return { close };
        }),
      };
      const controller = new TrackingController({} as TrackingService, stream as unknown as TrackingStreamService);
      const res = fakeResponse();

      await controller.streamDeliveryTracking('d-1', 'Bearer customer', res as unknown as Response);

      expect(stream.open).toHaveBeenCalledWith('d-1', 'Bearer customer', expect.anything());
      expect(res.statusCode).toBe(200);
      expect(res.headers).toMatchObject({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      expect(res.body).toBe(`event: tracking\ndata: ${JSON.stringify(snapshot)}\n\n: ping\n\n`);

      res.emit('close');
      expect(close).toHaveBeenCalledWith('client_closed');
    });

    it('an error event is written as such and the response ends', async () => {
      const stream = {
        open: jest.fn(async (_id: string, _auth: string, sink: TrackingStreamSink) => {
          sink.send(snapshot as never);
          sink.fail({ statusCode: 503, message: 'Tracking is temporarily unavailable' });
          sink.close();
          return { close: jest.fn() };
        }),
      };
      const controller = new TrackingController({} as TrackingService, stream as unknown as TrackingStreamService);
      const res = fakeResponse();

      await controller.streamDeliveryTracking('d-1', 'Bearer customer', res as unknown as Response);

      expect(res.body).toContain('event: error\ndata: {"statusCode":503,"message":"Tracking is temporarily unavailable"}\n\n');
      expect(res.writableEnded).toBe(true);
    });

    it('another customer: the rejection propagates before any byte or header is written (JSON 403 via the filter)', async () => {
      const stream = { open: jest.fn(async () => Promise.reject(new ForbiddenError('You do not have access to this delivery'))) };
      const controller = new TrackingController({} as TrackingService, stream as unknown as TrackingStreamService);
      const res = fakeResponse();

      await expect(controller.streamDeliveryTracking('d-1', 'Bearer other', res as unknown as Response)).rejects.toThrow(ForbiddenError);
      expect(res.headersSent).toBe(false);
      expect(res.body).toBe('');
    });

    it('a client that left while the stream was opening gets its subscription closed at once', async () => {
      const close = jest.fn(async () => undefined);
      const res = fakeResponse();
      const stream = {
        open: jest.fn(async () => {
          res.emit('close');
          return { close };
        }),
      };
      const controller = new TrackingController({} as TrackingService, stream as unknown as TrackingStreamService);

      await controller.streamDeliveryTracking('d-1', 'Bearer customer', res as unknown as Response);
      expect(close).toHaveBeenCalledWith('client_closed');
    });
  });
});
