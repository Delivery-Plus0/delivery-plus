import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AllExceptionsFilter, createServiceLogger } from '@food-delivery/shared';
import { AppModule } from './app.module';
import { loadConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = createServiceLogger(config.serviceName);
  if (config.simulatorInProduction) {
    // #201: allowed only by an explicit override, and never quietly.
    logger.warn(
      'PAYMENT_SIMULATOR_IN_PRODUCTION=true: payments are SIMULATED in production. No real money moves. ' +
        'Use this only for a closed demo until a real payment provider is configured.',
      { event: 'payment.simulator_in_production' },
    );
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(logger));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Payment Service')
    .setDescription('Simulated payment processing')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(config.port);
  logger.info(`${config.serviceName} listening on port ${config.port}`, { event: 'service.started' });
}

bootstrap();
