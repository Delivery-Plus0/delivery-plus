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

describe('RestaurantsService', () => {
  let service: RestaurantsService;
  let repo: jest.Mocked<RestaurantsRepository>;
  let storage: jest.Mocked<S3StorageService>;
  let cache: { getOrSet: jest.Mock; del: jest.Mock };

  const baseRestaurant = {
    id: 'r1',
    ownerId: 'owner-1',
    name: 'Pizza Place',
    description: undefined,
    address: '123 Main St',
    status: RestaurantStatus.CLOSED,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    repo = {
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      list: jest.fn(),
      findOpenById: jest.fn(),
    } as unknown as jest.Mocked<RestaurantsRepository>;

    storage = {
      generateUploadUrl: jest.fn(),
      verifyUploadedObject: jest.fn(),
      getPublicUrl: jest.fn(),
    } as unknown as jest.Mocked<S3StorageService>;
    cache = { getOrSet: jest.fn((_key, callback) => callback()), del: jest.fn() };

    service = new RestaurantsService(repo, cache as any, storage);
  });

  it('getById throws NotFoundError when missing', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(service.getById('missing')).rejects.toThrow(NotFoundError);
  });

  it('update throws ForbiddenError when requester is not the owner', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);
    await expect(service.update('r1', 'someone-else', { name: 'New' })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('update succeeds for the owner', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);
    repo.update.mockResolvedValue({ ...baseRestaurant, name: 'New Name' });

    const result = await service.update('r1', 'owner-1', { name: 'New Name' });
    expect(result.name).toBe('New Name');
  });

  it('updateStatus allows the owner to change status', async () => {
    repo.findById.mockResolvedValue(baseRestaurant);
    repo.update.mockResolvedValue({ ...baseRestaurant, status: RestaurantStatus.OPEN });

    const result = await service.updateStatus('r1', 'owner-1', UserRole.RESTAURANT_OWNER, {
      status: RestaurantStatus.OPEN,
    });
    expect(result.status).toBe(RestaurantStatus.OPEN);
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
    repo.list.mockResolvedValue([[baseRestaurant], 1]);
    const result = await service.list({ page: 1, limit: 20, sortBy: 'createdAt', sortOrder: 'DESC' });
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.totalPages).toBe(1);
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
});
