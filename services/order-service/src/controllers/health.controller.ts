import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { KafkaConsumerService, KafkaProducerService } from '@food-delivery/shared';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly kafkaProducer: KafkaProducerService,
    private readonly kafkaConsumer: KafkaConsumerService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Health check for the order service' })
  health() {
    return { status: 'ok' };
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness check for the order service' })
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness check for the order service' })
  async ready() {
    const checks: Record<string, 'ok' | 'error'> = { postgres: 'ok', kafka: 'ok' };

    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      checks.postgres = 'error';
    }

    if (!this.kafkaProducer.isReady() || !this.kafkaConsumer.isReady()) {
      checks.kafka = 'error';
    }

    const healthy = Object.values(checks).every((v) => v === 'ok');
    if (!healthy) {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }

    return { status: 'ok', checks };
  }
}
