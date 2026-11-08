import { AppError } from '@food-delivery/shared';

/** #208: one restaurant per owner for now (owner decision): a second create is refused (409). */
export class RestaurantLimitReachedError extends AppError {
  constructor() {
    super(409, 'RestaurantLimitReached', 'You already have a restaurant on this account. Contact support to add another branch.');
  }
}

/** #208: only an APPROVED restaurant can open or take orders (409). */
export class RestaurantNotApprovedError extends AppError {
  constructor(approvalStatus: string) {
    super(
      409,
      'RestaurantNotApproved',
      approvalStatus === 'SUBMITTED'
        ? 'Your restaurant is waiting for review. You can open it once it is approved.'
        : 'Your restaurant needs to be approved before it can open. Complete and submit your application.',
      { approvalStatus },
    );
  }
}

/** #208: the change is not allowed in the application's current state (409). */
export class RestaurantApplicationNotEditableError extends AppError {
  constructor(approvalStatus: string, fields: string[] = []) {
    super(
      409,
      'ApplicationNotEditable',
      approvalStatus === 'SUBMITTED'
        ? 'Your application is waiting for review; these details can no longer be changed.'
        : 'These details can no longer be changed. Contact support.',
      { approvalStatus, ...(fields.length ? { fields } : {}) },
    );
  }
}

export type RestaurantApplicationRequirement = 'legalName' | 'contactPhone' | 'location' | 'menuCategory' | 'availableMenuItem';

/** #208: submit (or an approval) found the application incomplete (422). */
export class RestaurantApplicationIncompleteError extends AppError {
  constructor(missing: RestaurantApplicationRequirement[]) {
    super(422, 'ApplicationIncomplete', 'Complete your application before submitting it.', { missing });
  }
}

/** #208: a review was refused: not waiting for review, or resubmitted since the reviewer loaded it (409). */
export class RestaurantApplicationNotInReviewError extends AppError {
  constructor(approvalStatus: string) {
    super(
      409,
      'ApplicationNotInReview',
      approvalStatus === 'SUBMITTED'
        ? 'The owner resubmitted the application. Reload it and review the new submission.'
        : 'This application is not waiting for review.',
      { approvalStatus },
    );
  }
}
