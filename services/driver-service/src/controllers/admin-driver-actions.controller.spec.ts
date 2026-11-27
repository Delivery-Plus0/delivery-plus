import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERMISSIONS_KEY } from '@food-delivery/shared';
import { AdminDriverActionsController } from './admin-driver-actions.controller';
import { AdminReasonDto, AdminReviewDriverDto } from '../dto/admin-driver-actions.dto';

describe('AdminDriverActionsController (#215)', () => {
  const required = (route: 'review' | 'suspend' | 'reactivate') => new Reflector().get(PERMISSIONS_KEY, AdminDriverActionsController.prototype[route]);

  it('needs onboarding.review to review and ops.act to suspend or reactivate', () => {
    expect(required('review')).toEqual(['onboarding.review']);
    expect(required('suspend')).toEqual(['ops.act']);
    expect(required('reactivate')).toEqual(['ops.act']);
  });

  it('requires a reason on every action', async () => {
    expect((await validate(plainToInstance(AdminReasonDto, {}))).map((e) => e.property)).toEqual(['reason']);
    expect((await validate(plainToInstance(AdminReasonDto, { reason: '  ' }))).map((e) => e.property)).toEqual(['reason']);
    const review = await validate(plainToInstance(AdminReviewDriverDto, { decision: 'VERIFIED', submittedAt: '2026-11-20T00:00:00.000Z' }));
    expect(review.map((e) => e.property)).toEqual(['reason']);
  });
});
