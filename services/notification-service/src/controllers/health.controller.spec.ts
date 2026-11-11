import { ServiceUnavailableException } from '@nestjs/common';

import { Connection } from 'typeorm';

import { KafkaConsumerService, KafkaProducerService } from '@food-delivery/shared';

import { HealthController } from './health.controller';

function kafkaMocks(producerReady = true, consumerReady = true) {
  return {
    producer: { isReady: jest.fn().mockReturnValue(producerReady) },
    consumer: { isReady: jest.fn().mockReturnValue(consumerReady) },
  };
}

describe('HealthController', () => {
  it('reports ready when the database answers', async () => {
    const connection = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const { producer, consumer } = kafkaMocks();
    const controller = new HealthController(
      connection as unknown as Connection,
      producer as unknown as KafkaProducerService,
      consumer as unknown as KafkaConsumerService,
    );

    await expect(controller.readiness()).resolves.toEqual({
      status: 'ok',
      checks: { postgres: 'ok', kafka: 'ok' },
    });
    expect(connection.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('answers 503 instead of 200 when the database is down', async () => {
    const connection = {
      query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    };
    const { producer, consumer } = kafkaMocks();
    const controller = new HealthController(
      connection as unknown as Connection,
      producer as unknown as KafkaProducerService,
      consumer as unknown as KafkaConsumerService,
    );

    const error = await controller.readiness().catch((e) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({ status: 'error', checks: { postgres: 'error', kafka: 'ok' } });
    // The connection error (host, port) must not reach whoever polls the probe.
    expect(JSON.stringify(error.getResponse())).not.toContain('10.0.0.5');
  });

  it('answers 503 when Kafka is not ready', async () => {
    const connection = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const { producer, consumer } = kafkaMocks(true, false);
    const controller = new HealthController(
      connection as unknown as Connection,
      producer as unknown as KafkaProducerService,
      consumer as unknown as KafkaConsumerService,
    );

    const error = await controller.readiness().catch((e) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({ status: 'error', checks: { postgres: 'ok', kafka: 'error' } });
  });

  it('keeps liveness independent of the database and Kafka', () => {
    const connection = { query: jest.fn() };
    const { producer, consumer } = kafkaMocks(false, false);
    const controller = new HealthController(
      connection as unknown as Connection,
      producer as unknown as KafkaProducerService,
      consumer as unknown as KafkaConsumerService,
    );

    expect(controller.liveness()).toEqual({ status: 'OK' });
    expect(connection.query).not.toHaveBeenCalled();
    expect(producer.isReady).not.toHaveBeenCalled();
    expect(consumer.isReady).not.toHaveBeenCalled();
  });
});
