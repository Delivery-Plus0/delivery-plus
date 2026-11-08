import { RestaurantsService } from './restaurants.service';
import { RestaurantsRepository } from '../repositories/restaurants.repository';
import {
  BadRequestError,
  RestaurantStatus,
  S3StorageService,
  UserRole,
  ForbiddenError,
  NotFoundError,
} from '@food-delivery/shared';
import { AppConfig } from '../config/app-config';
import { Restaurant } from '../entities/restaurant.entity';
import { MenuServiceClient } from '../common/menu-service.client';
import { NotInReviewError, OwnerHasRestaurantError } from '../repositories/restaurants.repository';

describe('RestaurantsService', () => {
  let service: RestaurantsService;
  let repo: jest.Mocked<RestaurantsRepository>;
  let storage: jest.Mocked<S3StorageService>;
  let cache: { getOrSet: jest.Mock; del: jest.Mock };
  let menus: { menuReadiness: jest.Mock };

  const baseRestaurant: Restaurant = {
    id: 'r1',
    ownerId: 'owner-1',
    name: 'Pizza Place',
    description: undefined,
    address: '123 Main St',
    latitude: null,
    longitude: null,
    deliveryRadiusKm: null,
    status: RestaurantStatus.CLOSED,
    approvalStatus: 'APPROVED',
    submittedAt: null,
    approvedAt: null,
    approvalNote: null,
    legalName: null,
    commercialRegistrationNumber: null,
    taxCardNumber: null,
    contactPhone: null,
    cuisineTags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      findByOwner: jest.fn(),
      createForOwner: jest.fn(),
      update: jest.fn(),
      updateIfApprovalIn: jest.fn(),
      submitIfSubmittable: jest.fn(),
      decideIfSubmitted: jest.fn().mockResolvedValue('decided'),
      reviews: jest.fn().mockResolvedValue([]),
      updateStatusUnlessSuspended: jest.fn(),
      list: jest.fn(),
      findOpenById: jest.fn(),
    } as unknown as jest.Mocked<RestaurantsRepository>;

    storage = {
      generateUploadUrl: jest.fn(),
      verifyUploadedObject: jest.fn(),
      getPublicUrl: jest.fn(),
    } as unknown as jest.Mocked<S3StorageService>;
    cache = { getOrSet: jest.fn((_key, callback) => callback()), del: jest.fn() };

    menus = { menuReadiness: jest.fn().mockResolvedValue({ categories: 1, availableItems: 1 }) };
    service = new RestaurantsService(repo, cache as any, storage, { defaultDeliveryRadiusKm: 5 } as AppConfig, menus as unknown as MenuServiceClient);
  });

  it('getById throws NotFoundError when missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.getById('missing')).rejects.toThrow(NotFoundError);
  });

  it('returns only customer-facing fields from a public restaurant read', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);

    const result = await service.getById('r1');

    expect(result).toMatchObject({ id: 'r1', name: 'Pizza Place', address: '123 Main St' });
    expect(result).not.toHaveProperty('ownerId');
    expect(result).not.toHaveProperty('createdAt');
    expect(result).toMatchObject({
      latitude: null,
      longitude: null,
      deliveryRadiusKm: 5,
    });
  });

  it('creates a restaurant with both supplied coordinates', async () => {
    repo.createForOwner.mockResolvedValue({
      ...baseRestaurant,
      latitude: 30.0444,
      longitude: 31.2357,
    });

    await service.create('owner-1', {
      name: 'Cairo Kitchen',
      address: '9 Nile Corniche',
      latitude: 30.0444,
      longitude: 31.2357,
    });

    expect(repo.createForOwner).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      name: 'Cairo Kitchen',
      address: '9 Nile Corniche',
      latitude: 30.0444,
      longitude: 31.2357,
    });
  });

  it('update throws ForbiddenError when requester is not the owner', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);
    await expect(service.update('r1', 'someone-else', { name: 'New' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('update succeeds for the owner', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);
    repo.updateIfApprovalIn.mockResolvedValue({ ...baseRestaurant, name: 'New Name', latitude: 30.0444, longitude: 31.2357 });

    const result = await service.update('r1', 'owner-1', { name: 'New Name', latitude: 30.0444, longitude: 31.2357 });
    expect(result.name).toBe('New Name');
    expect(repo.updateIfApprovalIn).toHaveBeenCalledWith(
      'r1',
      { name: 'New Name', latitude: 30.0444, longitude: 31.2357 },
      ['DRAFT', 'APPROVED', 'REJECTED'],
    );
    expect(cache.del).toHaveBeenCalledWith('restaurant:r1');
  });

  it('updateStatus allows the owner to change status (compare-and-set against SUSPENDED)', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);
    repo.updateStatusUnlessSuspended.mockResolvedValue({ ...baseRestaurant, status: RestaurantStatus.OPEN });

    const result = await service.updateStatus('r1', 'owner-1', UserRole.RESTAURANT_OWNER, {
      status: RestaurantStatus.OPEN,
    });
    expect(result.status).toBe(RestaurantStatus.OPEN);
    expect(repo.updateStatusUnlessSuspended).toHaveBeenCalledWith('r1', RestaurantStatus.OPEN);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('updateStatus refuses an owner setting SUSPENDED (#125)', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);

    await expect(
      service.updateStatus('r1', 'owner-1', UserRole.RESTAURANT_OWNER, { status: RestaurantStatus.SUSPENDED }),
    ).rejects.toThrow(ForbiddenError);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.updateStatusUnlessSuspended).not.toHaveBeenCalled();
  });

  it.each([RestaurantStatus.OPEN, RestaurantStatus.BUSY, RestaurantStatus.CLOSED])(
    'updateStatus refuses an owner lifting an admin suspension (→ %s) (#125)',
    async (target) => {
      repo.findById.mockResolvedValue({ ...baseRestaurant, status: RestaurantStatus.SUSPENDED });
      repo.updateStatusUnlessSuspended.mockResolvedValue(null); // the compare-and-set found it SUSPENDED

      await expect(service.updateStatus('r1', 'owner-1', UserRole.RESTAURANT_OWNER, { status: target })).rejects.toThrow(
        ForbiddenError,
      );
      expect(repo.update).not.toHaveBeenCalled();
    },
  );

  it('updateStatus refuses the owner even when the cached read still shows the restaurant unsuspended', async () => {
    // An admin suspended it after the owner's (cached) ownership read; the database write decides.
    repo.findById.mockResolvedValue({ ...baseRestaurant, status: RestaurantStatus.OPEN });
    repo.updateStatusUnlessSuspended.mockResolvedValue(null);

    await expect(
      service.updateStatus('r1', 'owner-1', UserRole.RESTAURANT_OWNER, { status: RestaurantStatus.CLOSED }),
    ).rejects.toThrow('suspended by an administrator');
    expect(cache.del).toHaveBeenCalledWith('restaurant:r1');
  });

  it('updateStatus lets ADMIN lift a suspension', async () => {
    repo.findById.mockResolvedValue({ ...baseRestaurant, status: RestaurantStatus.SUSPENDED });
    repo.update.mockResolvedValue({ ...baseRestaurant, status: RestaurantStatus.OPEN });

    const result = await service.updateStatus('r1', 'admin-1', UserRole.ADMIN, { status: RestaurantStatus.OPEN });
    expect(result.status).toBe(RestaurantStatus.OPEN);
    expect(repo.updateStatusUnlessSuspended).not.toHaveBeenCalled();
  });

  it('updateStatus allows ADMIN to bypass ownership', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);
    repo.update.mockResolvedValue({ ...baseRestaurant, status: RestaurantStatus.SUSPENDED });

    const result = await service.updateStatus('r1', 'admin-1', UserRole.ADMIN, {
      status: RestaurantStatus.SUSPENDED,
    });
    expect(result.status).toBe(RestaurantStatus.SUSPENDED);
  });

  it('updateStatus rejects a non-owner, non-admin', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);
    await expect(
      service.updateStatus('r1', 'random-user', UserRole.CUSTOMER, {
        status: RestaurantStatus.OPEN,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('list returns a paginated result', async () => {
    repo.list.mockResolvedValue([[{ restaurant: baseRestaurant }], 1]);
    const result = await service.list({ page: 1, limit: 20, sortBy: 'createdAt', sortOrder: 'DESC' });
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.totalPages).toBe(1);
    expect(result.items[0]).not.toHaveProperty('ownerId');
    expect(result.items[0]).not.toHaveProperty('distanceKm');
    expect(repo.list).toHaveBeenCalledWith(
      { page: 1, limit: 20, sortBy: 'createdAt', sortOrder: 'DESC' },
      5,
    );
  });

  it('includes distance only for coordinate-filtered results', async () => {
    repo.list.mockResolvedValue([[{ restaurant: baseRestaurant, distanceKm: 2.4 }], 1]);

    const result = await service.list({
      page: 1,
      limit: 20,
      sortBy: 'createdAt',
      sortOrder: 'DESC',
      lat: 30.0444,
      lng: 31.2357,
    });

    expect(result.items[0]).toMatchObject({ distanceKm: 2.4, deliveryRadiusKm: 5 });
  });

  it('persists an admin radius override and invalidates the restaurant cache', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);
    repo.update.mockResolvedValue({ ...baseRestaurant, deliveryRadiusKm: '8.25' });

    const result = await service.setDeliveryRadius('r1', 8.25);

    expect(repo.update).toHaveBeenCalledWith('r1', { deliveryRadiusKm: '8.25' });
    expect(cache.del).toHaveBeenCalledWith('restaurant:r1');
    expect(result.deliveryRadiusKm).toBe(8.25);
  });

  it('selects owned restaurants using the authenticated owner id', async () => {
    repo.findByOwner.mockResolvedValue([baseRestaurant]);

    const result = await service.listMine('owner-1');

    expect(repo.findByOwner).toHaveBeenCalledWith('owner-1');
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('ownerId');
  });

  it('rejects a mismatched image key before persisting a restaurant image URL', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);
    storage.verifyUploadedObject.mockRejectedValue(new BadRequestError('Object key prefix mismatch'));

    await expect(
      service.confirmImageUpload(
        'r1',
        'owner-1',
        'logo',
        'restaurants/other/logo/01234567-89ab-cdef-0123-456789abcdef.png',
      ),
    ).rejects.toThrow(BadRequestError);

    expect(storage.verifyUploadedObject).toHaveBeenCalledWith(
      'restaurants/other/logo/01234567-89ab-cdef-0123-456789abcdef.png',
      'restaurants/r1/logo/',
      10 * 1024 * 1024,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('checks restaurant ownership before issuing an image upload URL', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);

    await expect(
      service.createImageUploadUrl('r1', 'someone-else', 'cover', 'image/jpeg'),
    ).rejects.toThrow(ForbiddenError);

    expect(storage.generateUploadUrl).not.toHaveBeenCalled();
  });
  describe('application and approval (#208)', () => {
    const draft: Restaurant = { ...baseRestaurant, approvalStatus: 'DRAFT' };
    const complete: Restaurant = { ...draft, legalName: 'Pizza Place LLC', contactPhone: '+201012345678', latitude: 30.04, longitude: 31.23 };
    const SUBMITTED_AT = new Date('2026-11-08T09:00:00Z');

    it('refuses a second restaurant for the same owner with 409', async () => {
      repo.createForOwner.mockRejectedValue(new OwnerHasRestaurantError());
      await expect(service.create('owner-1', { name: 'Second', address: 'x' })).rejects.toMatchObject({
        statusCode: 409,
        error: 'RestaurantLimitReached',
      });
    });

    it('hides a restaurant that is not approved from the public read', async () => {
      for (const approvalStatus of ['DRAFT', 'SUBMITTED', 'REJECTED'] as const) {
        repo.findById.mockResolvedValue({ ...baseRestaurant, approvalStatus });
        await expect(service.getById('r1')).rejects.toThrow(NotFoundError);
      }
    });

    it('shows the owner the application, the private details and the latest note', async () => {
      repo.findByOwner.mockResolvedValue([{ ...complete, approvalStatus: 'REJECTED', approvalNote: 'Logo missing' }]);
      repo.reviews.mockResolvedValue([
        { id: 'v1', restaurantId: 'r1', reviewerUserId: 'staff-1', decision: 'REJECTED', note: 'Logo missing', applicationSubmittedAt: SUBMITTED_AT, reviewedAt: SUBMITTED_AT },
      ]);

      const [mine] = await service.listMine('owner-1');

      expect(mine).toMatchObject({
        approvalStatus: 'REJECTED',
        approvalNote: 'Logo missing',
        legalName: 'Pizza Place LLC',
        contactPhone: '+201012345678',
        lastReview: { decision: 'REJECTED', note: 'Logo missing', reviewedAt: SUBMITTED_AT },
      });
      expect(mine.lastReview).not.toHaveProperty('reviewerUserId');
      expect(mine).not.toHaveProperty('ownerId');
    });

    it('never puts the private application details in the public card', async () => {
      repo.findById.mockResolvedValue({ ...complete, approvalStatus: 'APPROVED' });
      const card = await service.getById('r1');
      for (const field of ['legalName', 'commercialRegistrationNumber', 'taxCardNumber', 'contactPhone', 'approvalNote']) {
        expect(card).not.toHaveProperty(field);
      }
    });

    it('refuses an owner opening a restaurant that is not approved with 409 RestaurantNotApproved', async () => {
      repo.findById.mockResolvedValue(draft);
      repo.updateStatusUnlessSuspended.mockResolvedValue(null);

      await expect(service.updateStatus('r1', 'owner-1', UserRole.RESTAURANT_OWNER, { status: RestaurantStatus.OPEN })).rejects.toMatchObject({
        statusCode: 409,
        error: 'RestaurantNotApproved',
        details: { approvalStatus: 'DRAFT' },
      });
    });

    it('submits a complete draft', async () => {
      repo.findById.mockResolvedValue(complete);
      repo.submitIfSubmittable.mockResolvedValue({ ...complete, approvalStatus: 'SUBMITTED', submittedAt: SUBMITTED_AT });

      const submitted = await service.submit('r1', 'owner-1');

      expect(submitted).toMatchObject({ approvalStatus: 'SUBMITTED', submittedAt: SUBMITTED_AT });
      expect(menus.menuReadiness).toHaveBeenCalledWith('r1');
      expect(cache.del).toHaveBeenCalledWith('restaurant:r1');
    });

    it('says everything that is missing before a submit', async () => {
      repo.findById.mockResolvedValue(draft);
      menus.menuReadiness.mockResolvedValue({ categories: 0, availableItems: 0 });

      await expect(service.submit('r1', 'owner-1')).rejects.toMatchObject({
        statusCode: 422,
        error: 'ApplicationIncomplete',
        details: { missing: ['legalName', 'contactPhone', 'location', 'menuCategory', 'availableMenuItem'] },
      });
      expect(repo.submitIfSubmittable).not.toHaveBeenCalled();
    });

    it('asks only for the legal name among the legal details (owner decision)', async () => {
      repo.findById.mockResolvedValue({ ...complete, commercialRegistrationNumber: null, taxCardNumber: null });
      repo.submitIfSubmittable.mockResolvedValue({ ...complete, approvalStatus: 'SUBMITTED', submittedAt: SUBMITTED_AT });
      await expect(service.submit('r1', 'owner-1')).resolves.toMatchObject({ approvalStatus: 'SUBMITTED' });
    });

    it('needs an available item, not just a category', async () => {
      repo.findById.mockResolvedValue(complete);
      menus.menuReadiness.mockResolvedValue({ categories: 2, availableItems: 0 });
      await expect(service.submit('r1', 'owner-1')).rejects.toMatchObject({ details: { missing: ['availableMenuItem'] } });
    });

    it.each(['SUBMITTED', 'APPROVED'] as const)('refuses to submit an application that is %s', async (approvalStatus) => {
      repo.findById.mockResolvedValue({ ...complete, approvalStatus });
      await expect(service.submit('r1', 'owner-1')).rejects.toMatchObject({ statusCode: 409, error: 'ApplicationNotEditable', details: { approvalStatus } });
    });

    it('resubmits a corrected rejected application', async () => {
      repo.findById.mockResolvedValue({ ...complete, approvalStatus: 'REJECTED', approvalNote: 'Logo missing' });
      repo.submitIfSubmittable.mockResolvedValue({ ...complete, approvalStatus: 'SUBMITTED', submittedAt: SUBMITTED_AT });
      await expect(service.submit('r1', 'owner-1')).resolves.toMatchObject({ approvalStatus: 'SUBMITTED', approvalNote: null });
    });

    it('lets the legal details change only before approval, and freezes the card while submitted', async () => {
      repo.findById.mockResolvedValue(complete);
      repo.updateIfApprovalIn.mockResolvedValue(complete);

      await service.update('r1', 'owner-1', { legalName: 'New LLC' });
      expect(repo.updateIfApprovalIn).toHaveBeenLastCalledWith('r1', { legalName: 'New LLC' }, ['DRAFT', 'REJECTED']);

      await service.update('r1', 'owner-1', { address: 'New street' });
      expect(repo.updateIfApprovalIn).toHaveBeenLastCalledWith('r1', { address: 'New street' }, ['DRAFT', 'APPROVED', 'REJECTED']);

      await service.update('r1', 'owner-1', { contactPhone: '+201112345678', cuisineTags: ['Pizza'] });
      expect(repo.updateIfApprovalIn).toHaveBeenLastCalledWith(
        'r1',
        { contactPhone: '+201112345678', cuisineTags: ['Pizza'] },
        ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
      );
    });

    it('answers 409 with the locked fields when the change is refused', async () => {
      repo.findById.mockResolvedValue({ ...complete, approvalStatus: 'APPROVED' });
      repo.updateIfApprovalIn.mockResolvedValue(null);

      await expect(service.update('r1', 'owner-1', { legalName: 'New LLC', description: 'x' })).rejects.toMatchObject({
        statusCode: 409,
        error: 'ApplicationNotEditable',
        details: { approvalStatus: 'APPROVED', fields: ['legalName'] },
      });
    });

    describe('review', () => {
      const review = (overrides: Record<string, unknown> = {}) =>
        ({ decision: 'APPROVED', submittedAt: SUBMITTED_AT.toISOString(), ...overrides }) as never;

      beforeEach(() => repo.findById.mockResolvedValue({ ...complete, approvalStatus: 'SUBMITTED', submittedAt: SUBMITTED_AT }));

      it('passes the decision on the exact submission to the compare-and-set and clears the cache', async () => {
        await service.review('staff-1', 'r1', review({ decision: 'REJECTED', note: 'Logo missing' }));

        expect(repo.decideIfSubmitted).toHaveBeenCalledWith(
          'r1',
          { decision: 'REJECTED', note: 'Logo missing', reviewerUserId: 'staff-1', submittedAt: SUBMITTED_AT },
          expect.any(Function),
        );
        expect(cache.del).toHaveBeenCalledWith('restaurant:r1');
      });

      it('re-checks the menu before an approval (422) but not before a rejection', async () => {
        menus.menuReadiness.mockResolvedValue({ categories: 1, availableItems: 0 });
        repo.decideIfSubmitted.mockImplementation(async (_id, _review, check) => {
          await check({ ...complete, approvalStatus: 'SUBMITTED' });
          return 'decided';
        });

        await expect(service.review('staff-1', 'r1', review())).rejects.toMatchObject({ statusCode: 422, details: { missing: ['availableMenuItem'] } });
        await expect(service.review('staff-1', 'r1', review({ decision: 'REJECTED', note: 'Menu empty' }))).resolves.toBeDefined();
      });

      it('answers 409 ApplicationNotInReview with the current status', async () => {
        repo.findById.mockResolvedValueOnce({ ...complete, approvalStatus: 'SUBMITTED' }).mockResolvedValueOnce({ ...complete, approvalStatus: 'APPROVED' });
        repo.decideIfSubmitted.mockRejectedValue(new NotInReviewError());

        await expect(service.review('staff-1', 'r1', review())).rejects.toMatchObject({
          statusCode: 409,
          error: 'ApplicationNotInReview',
          details: { approvalStatus: 'APPROVED' },
        });
      });

      it('shows staff the owner and the whole history', async () => {
        repo.reviews.mockResolvedValue([
          { id: 'v1', restaurantId: 'r1', reviewerUserId: 'staff-1', decision: 'APPROVED', note: null, applicationSubmittedAt: SUBMITTED_AT, reviewedAt: SUBMITTED_AT },
        ]);
        const view = await service.review('staff-1', 'r1', review());
        expect(view).toMatchObject({ ownerId: 'owner-1', reviews: [{ id: 'v1', decision: 'APPROVED', reviewerUserId: 'staff-1' }] });
      });
    });
  });
  it('gives delivery-service the contact phone, even before approval (#211)', async () => {
    repo.findById.mockResolvedValue({ ...baseRestaurant, contactPhone: '+201012345678' });
    await expect(service.getContact('r1')).resolves.toEqual({ id: 'r1', contactPhone: '+201012345678' });
    repo.findById.mockResolvedValue(null);
    await expect(service.getContact('r1')).rejects.toThrow(NotFoundError);
  });
});
