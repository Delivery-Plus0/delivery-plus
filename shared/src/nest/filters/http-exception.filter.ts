import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { AppError } from '../../errors/app-error';
import { ErrorResponse } from '../../types/error-response';
import { RequestWithContext } from '../middleware/correlation-id.middleware';
import { WinstonLogger } from '../../logging/logger';

/** F3 (#204): what a client sees for an unexpected error. The real error goes to the log only. */
export const INTERNAL_ERROR_MESSAGE = 'Something went wrong';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: WinstonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithContext>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'InternalServerError';
    let message = INTERNAL_ERROR_MESSAGE;
    let details: Record<string, unknown> | undefined;
    // F3 (#204): anything that isn't an AppError or HttpException (a TypeORM error, a bug, a failed
    // fetch) may carry SQL, hostnames or stack details. It is logged in full, never returned.
    let unexpected: { message: string; stack?: string; name?: string } | undefined;

    if (exception instanceof AppError) {
      statusCode = exception.statusCode;
      error = exception.error;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      error = exception.name.replace('Exception', '');
      message =
        typeof body === 'string'
          ? body
          : ((body as Record<string, unknown>).message as string) || exception.message;
    } else if (exception instanceof Error) {
      unexpected = { name: exception.name, message: exception.message, stack: exception.stack };
    } else {
      unexpected = { message: String(exception) };
    }

    const body: ErrorResponse = {
      statusCode,
      error,
      message: Array.isArray(message) ? message.join(', ') : message,
      timestamp: new Date().toISOString(),
      path: request.url,
      correlationId: request.correlationId,
      ...(details ? { details } : {}),
    };

    this.logger.log({
      level: statusCode >= 500 ? 'error' : 'warn',
      message: `${error}: ${body.message}`,
      correlationId: request.correlationId,
      requestId: request.requestId,
      statusCode,
      path: request.url,
      ...(unexpected ? { cause: unexpected } : {}),
    });

    response.status(statusCode).json(body);
  }
}
