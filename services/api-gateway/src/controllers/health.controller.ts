import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

// NOTE (CI tooling fix): every other service already has this exact
// health.controller.ts pattern; the API Gateway did not, so
// docker-compose.test.yml's healthcheck (`wget --spider .../health`) could
// never pass -- integration.yml's `docker compose up --wait` failed on
// api-gateway unconditionally, before any critical-path test ever ran.
// The gateway has no database of its own to check, so this only offers the
// same liveness-style checks the other services expose, not a /ready
// dependency check.
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Health check for the API Gateway' })
  health() {
    return { status: 'ok' };
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness check for the API Gateway' })
  live() {
    // Liveness: process is up and can respond. No dependency checks.
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness check for the API Gateway' })
  ready() {
    // Readiness (#8): the gateway owns no data of its own and proxies to
    // upstreams that report their own /health/ready, so its readiness is
    // process-only. Per-upstream health is visible through each service's
    // /health/ready; the gateway must not fail readiness because a single
    // upstream is temporarily down (that would take the whole platform
    // offline behind one load balancer probe).
    return { status: 'ok', checks: { process: 'ok' } };
  }
}