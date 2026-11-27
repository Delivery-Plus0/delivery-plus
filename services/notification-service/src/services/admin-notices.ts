/**
 * #215: the in-app notices of staff decisions, by message key (#151). The apps translate the key
 * (Arabic and English); the English title and message are stored for older clients. `note` is the
 * reviewer's own words to the person, shown as written; nothing else in params is free text.
 */
export const ADMIN_NOTICES: Record<string, { title: string; message: (params: Record<string, string>) => string }> = {
  'driver.application_approved': {
    title: 'Application approved',
    message: () => 'Your driver application was approved. You can go online now.',
  },
  'driver.application_rejected': {
    title: 'Application needs changes',
    message: (p) => `Your driver application was not approved.${p.note ? ` Reviewer's note: ${p.note}` : ''} You can fix it and submit again.`,
  },
  'restaurant.application_approved': {
    title: 'Restaurant approved',
    message: (p) => `${p.restaurantName ?? 'Your restaurant'} was approved and can now take orders.`,
  },
  'restaurant.application_rejected': {
    title: 'Restaurant needs changes',
    message: (p) => `${p.restaurantName ?? 'Your restaurant'} was not approved.${p.note ? ` Reviewer's note: ${p.note}` : ''} You can fix it and submit again.`,
  },
  'driver.review_withdrawn': {
    title: 'Application back in review',
    message: () => 'The last decision on your driver application was withdrawn. Your application is back in review.',
  },
  'restaurant.review_withdrawn': {
    title: 'Restaurant back in review',
    message: (p) => `The last decision on ${p.restaurantName ?? 'your restaurant'} was withdrawn. It is back in review.`,
  },
  'driver.suspended': {
    title: 'Driving paused',
    message: () => 'Your driver account was suspended by Delivery Plus. Contact support if you think this is a mistake.',
  },
  'driver.reactivated': {
    title: 'Driving resumed',
    message: () => 'Your driver account was reactivated. You can go online again.',
  },
  'restaurant.suspended': {
    title: 'Restaurant suspended',
    message: (p) => `${p.restaurantName ?? 'Your restaurant'} was suspended by Delivery Plus and is hidden from customers. Contact support for details.`,
  },
  'restaurant.reactivated': {
    title: 'Restaurant reactivated',
    message: (p) => `${p.restaurantName ?? 'Your restaurant'} was reactivated. Set it to open when you are ready.`,
  },
  'account.reactivated': {
    title: 'Account reactivated',
    message: () => 'Your Delivery Plus account was reactivated. You can sign in again.',
  },
};
