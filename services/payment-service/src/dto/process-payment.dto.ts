import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class ProcessPaymentDto {
  /**
   * Test hook (#201): force the simulated outcome. Accepted only when PAYMENT_TEST_HOOKS=true, which
   * only the test and E2E stacks set; anywhere else sending it at all is a 400.
   */
  @ApiPropertyOptional({
    description:
      'Test hook, test and E2E stacks only (PAYMENT_TEST_HOOKS=true): true forces a decline, false forces success. ' +
      'Anywhere else, sending this field at all returns 400 "simulateFailure is a test hook and is disabled". ' +
      'Clients must omit it.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  simulateFailure?: boolean;
}
