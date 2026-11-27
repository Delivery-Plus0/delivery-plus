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

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter(logger));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Audit Service')
    .setDescription('Append-only log of staff actions (#213)')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));

  await app.listen(config.port);
  logger.info(`${config.serviceName} listening on port ${config.port}`, { event: 'service.started' });
}

bootstrap();
