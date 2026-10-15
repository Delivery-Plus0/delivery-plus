import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  @ApiOperation({ summary: 'Health check for the notification service' })
  check() {
    return { status: 'OK', service: 'notification-service' };
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness check for the notification service' })
  liveness() {
    return { status: 'OK' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness check for the notification service' })
  async readiness() {
    const checks: Record<string, 'ok' | 'error'> = { postgres: 'ok' };

    try {
      await this.connection.query('SELECT 1');
    } catch {
      checks.postgres = 'error';
    }

    const healthy = Object.values(checks).every((v) => v === 'ok');
    if (!healthy) {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }

    return { status: 'ok', checks };
  }
}
