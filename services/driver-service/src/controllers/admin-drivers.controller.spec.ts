import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERMISSIONS_KEY } from '@food-delivery/shared';
import { HEADERS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { AdminDriversController } from './admin-drivers.controller';
import { AdminListDriversQueryDto } from '../dto/admin-drivers.dto';

describe('AdminDriversController (#214)', () => {
  const required = (route: 'list' | 'queue' | 'detail' | 'documentReadUrl') => new Reflector().get(PERMISSIONS_KEY, AdminDriversController.prototype[route]);

  it('needs support.read for the list and the page, onboarding.review for the queue', () => {
    expect(required('list')).toEqual(['support.read']);
    expect(required('detail')).toEqual(['support.read']);
    expect(required('queue')).toEqual(['onboarding.review']);
  });

  it('gives a document URL to onboarding.review only, never cached, through the recorded read (#323)', async () => {
    expect(required('documentReadUrl')).toEqual(['onboarding.review']);
    const handler = AdminDriversController.prototype.documentReadUrl;
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);

    const url = { type: 'selfie', version: 2, contentType: 'image/jpeg', url: 'https://storage.example/x', expiresIn: 300 };
    const applications = { createReadUrl: jest.fn().mockResolvedValue(url) };
    const controller = new AdminDriversController({} as never, applications as never);
    await expect(controller.documentReadUrl({ sub: 'staff-1' } as never, 'driver-1', 'selfie')).resolves.toBe(url);
    expect(applications.createReadUrl).toHaveBeenCalledWith('staff-1', 'driver-1', 'selfie');
  });

  it('declares the queue before :id', () => {
    const names = Object.getOwnPropertyNames(AdminDriversController.prototype);
    expect(names.indexOf('queue')).toBeLessThan(names.indexOf('detail'));
  });
});

describe('AdminListDriversQueryDto (#214)', () => {
  it('uppercases the plate prefix and refuses wildcards or a page above 100', async () => {
    const query = plainToInstance(AdminListDriversQueryDto, { q: ' abc 1 ', licenceExpiringWithinDays: '30' });
    expect(await validate(query)).toHaveLength(0);
    expect(query).toMatchObject({ q: 'ABC 1', licenceExpiringWithinDays: 30 });
    const errors = await validate(plainToInstance(AdminListDriversQueryDto, { q: 'A%', limit: 101, status: 'ASLEEP' }));
    expect(errors.map((e) => e.property)).toEqual(expect.arrayContaining(['q', 'limit', 'status']));
  });
});
