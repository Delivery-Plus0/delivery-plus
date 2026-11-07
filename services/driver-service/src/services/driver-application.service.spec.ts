import { createHmac } from 'node:crypto';
import { BadRequestError, NotFoundError, PrivateDocumentStorage } from '@food-delivery/shared';
import { AppConfig, LOCAL_NATIONAL_ID_HMAC_SECRET } from '../config/app-config';
import {
  ApplicationLockedError,
  DocumentVersionLimitError,
  DriverApplicationRepository,
  DriverApplicationRow,
  DuplicateNationalIdError,
} from '../repositories/driver-application.repository';
import { DriverDocument } from '../entities/driver-document.entity';
import { DRIVER_DOCUMENT_TYPES, DriverDocumentType } from '../common/driver-documents';
import { DriverApplicationService, applicationStatus, cairoDate } from './driver-application.service';

const DRIVER_ID = '0b6c3c1e-5d0f-4d7e-9a43-1f6f8e2b7a10';
const NOW = new Date('2026-11-07T10:00:00Z');
const VALID = { nationalIdNumber: '29001011234567', drivingLicenceExpiresOn: '2028-05-31', vehicleLicenceExpiresOn: '2027-01-15' };

function driver(overrides: Partial<DriverApplicationRow> = {}): DriverApplicationRow {
  return {
    id: DRIVER_ID,
    userId: 'user-1',
    verificationStatus: 'PENDING',
    verificationNote: null,
    verifiedAt: null,
    submittedAt: null,
    nationalIdLast4: null,
    drivingLicenceExpiresOn: null,
    vehicleLicenceExpiresOn: null,
    ...overrides,
  } as DriverApplicationRow;
}

function document(type: DriverDocumentType, version = 1): DriverDocument {
  return {
    id: `doc-${type}-${version}`,
    driverId: DRIVER_ID,
    type,
    version,
    isCurrent: true,
    objectKey: `drivers/${DRIVER_ID}/documents/${type}/01234567-89ab-cdef-0123-456789abcdef.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 1000,
    sha256: 'a'.repeat(64),
    uploadedAt: NOW,
  };
}

const allDocuments = () => DRIVER_DOCUMENT_TYPES.map((type) => document(type));
const complete = () => driver({ nationalIdLast4: '4567', drivingLicenceExpiresOn: '2028-05-31', vehicleLicenceExpiresOn: '2027-01-15' });

describe('DriverApplicationService (#207)', () => {
  let repository: jest.Mocked<DriverApplicationRepository>;
  let storage: jest.Mocked<PrivateDocumentStorage>;
  let service: DriverApplicationService;

  beforeEach(() => {
    repository = {
      findApplication: jest.fn().mockResolvedValue(driver()),
      currentDocuments: jest.fn().mockResolvedValue([]),
      findCurrentDocumentWithKey: jest.fn(),
      saveFieldsIfDraft: jest.fn().mockResolvedValue(undefined),
      addDocumentVersion: jest.fn().mockImplementation(async (_id, type) => document(type)),
      submitIfDraft: jest.fn(),
      recordAccess: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<DriverApplicationRepository>;
    storage = {
      createUpload: jest.fn().mockResolvedValue({ uploadUrl: 'u', objectKey: 'k', expiresIn: 300, method: 'POST', fields: {} }),
      promote: jest.fn(),
      createReadUrl: jest.fn().mockResolvedValue({ url: 'https://signed.example/doc', expiresIn: 300 }),
    } as unknown as jest.Mocked<PrivateDocumentStorage>;
    service = new DriverApplicationService(repository, storage, { nationalIdHmacSecret: LOCAL_NATIONAL_ID_HMAC_SECRET } as AppConfig);
  });

  describe('application status', () => {
    it('maps the verification status and submittedAt to DRAFT, SUBMITTED, VERIFIED or REJECTED', () => {
      expect(applicationStatus({ verificationStatus: 'PENDING', submittedAt: null })).toBe('DRAFT');
      expect(applicationStatus({ verificationStatus: 'PENDING', submittedAt: NOW })).toBe('SUBMITTED');
      expect(applicationStatus({ verificationStatus: 'VERIFIED', submittedAt: null })).toBe('VERIFIED');
      expect(applicationStatus({ verificationStatus: 'REJECTED', submittedAt: NOW })).toBe('REJECTED');
    });
  });

  describe('saveApplication', () => {
    it('stores only the last 4 digits and a keyed HMAC of the national ID', async () => {
      await service.saveApplication(DRIVER_ID, VALID, NOW);

      const saved = repository.saveFieldsIfDraft.mock.calls[0][1];
      expect(saved.nationalIdLast4).toBe('4567');
      expect(saved.nationalIdHash).toBe(
        createHmac('sha256', LOCAL_NATIONAL_ID_HMAC_SECRET).update('national-id:v1:29001011234567').digest('hex'),
      );
      expect(JSON.stringify(saved)).not.toContain('29001011234567');
    });

    it('gives a different hash under a different secret', async () => {
      const other = new DriverApplicationService(repository, storage, { nationalIdHmacSecret: 'another-secret-another-secret-xx' } as AppConfig);
      await service.saveApplication(DRIVER_ID, VALID, NOW);
      await other.saveApplication(DRIVER_ID, VALID, NOW);
      const [first, second] = repository.saveFieldsIfDraft.mock.calls.map((call) => call[1].nationalIdHash);
      expect(first).not.toBe(second);
    });

    it('answers 409 NationalIdAlreadyRegistered for an ID on another account', async () => {
      repository.saveFieldsIfDraft.mockRejectedValue(new DuplicateNationalIdError());
      await expect(service.saveApplication(DRIVER_ID, VALID, NOW)).rejects.toMatchObject({ statusCode: 409, error: 'NationalIdAlreadyRegistered' });
    });

    it.each([
      ['an expired licence', { drivingLicenceExpiresOn: '2026-11-06' }, 'in the past'],
      ['an impossible date', { vehicleLicenceExpiresOn: '2027-02-30' }, 'not a real date'],
      ['a typo far in the future', { vehicleLicenceExpiresOn: '2099-01-01' }, 'years away'],
    ])('refuses %s', async (_label, change, message) => {
      await expect(service.saveApplication(DRIVER_ID, { ...VALID, ...change }, NOW)).rejects.toThrow(message);
      expect(repository.saveFieldsIfDraft).not.toHaveBeenCalled();
    });

    it('accepts a licence that expires today in Cairo', async () => {
      // 23:30 UTC on Nov 6 is already Nov 7 in Cairo.
      const lateEvening = new Date('2026-11-06T23:30:00Z');
      expect(cairoDate(lateEvening)).toBe('2026-11-07');
      await expect(service.saveApplication(DRIVER_ID, { ...VALID, drivingLicenceExpiresOn: '2026-11-07' }, lateEvening)).resolves.toBeDefined();
    });

    it.each([
      ['SUBMITTED', { submittedAt: NOW }],
      ['VERIFIED', { verificationStatus: 'VERIFIED' as const }],
      ['REJECTED', { verificationStatus: 'REJECTED' as const }],
    ])('refuses changes once the application is %s', async (status, overrides) => {
      repository.findApplication.mockResolvedValue(driver(overrides));
      await expect(service.saveApplication(DRIVER_ID, VALID, NOW)).rejects.toMatchObject({
        statusCode: 409,
        error: 'ApplicationNotEditable',
        details: { applicationStatus: status },
      });
    });

    it('reports the new status when the draft was submitted between the read and the write', async () => {
      repository.findApplication.mockResolvedValueOnce(driver()).mockResolvedValueOnce(driver({ submittedAt: NOW }));
      repository.saveFieldsIfDraft.mockRejectedValue(new ApplicationLockedError());
      await expect(service.saveApplication(DRIVER_ID, VALID, NOW)).rejects.toMatchObject({
        error: 'ApplicationNotEditable',
        details: { applicationStatus: 'SUBMITTED' },
      });
    });

    it('answers 404 for a driver that does not exist', async () => {
      repository.findApplication.mockResolvedValue(null);
      await expect(service.saveApplication(DRIVER_ID, VALID, NOW)).rejects.toThrow(NotFoundError);
    });
  });

  describe('uploads', () => {
    it('issues uploads under the driver and document prefix with the 10 MB limit', async () => {
      await service.createUpload(DRIVER_ID, 'driving-licence', 'application/pdf');
      expect(storage.createUpload).toHaveBeenCalledWith(`drivers/${DRIVER_ID}/driving-licence/`, 'application/pdf', 10 * 1024 * 1024);
    });

    it('refuses an unknown document type', async () => {
      await expect(service.createUpload(DRIVER_ID, 'passport', 'image/png')).rejects.toThrow(BadRequestError);
      await expect(service.confirmUpload(DRIVER_ID, '../selfie', 'k')).rejects.toThrow(BadRequestError);
      expect(storage.createUpload).not.toHaveBeenCalled();
    });

    it('refuses uploads once the application is submitted', async () => {
      repository.findApplication.mockResolvedValue(driver({ submittedAt: NOW }));
      await expect(service.createUpload(DRIVER_ID, 'selfie', 'image/png')).rejects.toMatchObject({ error: 'ApplicationNotEditable' });
      await expect(service.confirmUpload(DRIVER_ID, 'selfie', 'k')).rejects.toMatchObject({ error: 'ApplicationNotEditable' });
      expect(storage.promote).not.toHaveBeenCalled();
    });

    it('promotes the upload into the driver prefix and records it', async () => {
      storage.promote.mockResolvedValue({ objectKey: 'final', contentType: 'image/png', contentLength: 42, sha256: 'b'.repeat(64) });

      await service.confirmUpload(DRIVER_ID, 'selfie', 'pending-key', NOW);

      expect(storage.promote).toHaveBeenCalledWith('pending-key', `drivers/${DRIVER_ID}/selfie/`, `drivers/${DRIVER_ID}/documents/selfie/`, 10 * 1024 * 1024);
      expect(repository.addDocumentVersion).toHaveBeenCalledWith(
        DRIVER_ID,
        'selfie',
        { objectKey: 'final', contentType: 'image/png', sizeBytes: 42, sha256: 'b'.repeat(64) },
        5,
      );
    });

    it('answers 409 DocumentVersionLimitReached past five versions', async () => {
      storage.promote.mockResolvedValue({ objectKey: 'final', contentType: 'image/png', contentLength: 42, sha256: 'b'.repeat(64) });
      repository.addDocumentVersion.mockRejectedValue(new DocumentVersionLimitError());
      await expect(service.confirmUpload(DRIVER_ID, 'selfie', 'pending-key', NOW)).rejects.toMatchObject({
        statusCode: 409,
        error: 'DocumentVersionLimitReached',
      });
    });
  });

  describe('getApplication', () => {
    it('lists documents without their object keys and says what is missing', async () => {
      repository.currentDocuments.mockResolvedValue([document('selfie')]);

      const view = await service.getApplication(DRIVER_ID, NOW);

      expect(view.status).toBe('DRAFT');
      expect(view.documents).toEqual([{ type: 'selfie', version: 1, contentType: 'image/jpeg', sizeBytes: 1000, uploadedAt: NOW }]);
      expect(view.missingDocuments).toEqual(['national-id-front', 'national-id-back', 'driving-licence', 'vehicle-licence']);
      expect(view.canSubmit).toBe(false);
      expect(JSON.stringify(view)).not.toMatch(/objectKey|drivers\//);
    });

    it('can be submitted with every field and document', async () => {
      repository.findApplication.mockResolvedValue(complete());
      repository.currentDocuments.mockResolvedValue(allDocuments());
      expect((await service.getApplication(DRIVER_ID, NOW)).canSubmit).toBe(true);
    });
  });

  describe('submit', () => {
    function runCheck(row: DriverApplicationRow, documents: DriverDocument[]) {
      repository.submitIfDraft.mockImplementation(async (_id, check) => check(row, documents));
    }

    it('submits a complete draft', async () => {
      runCheck(complete(), allDocuments());
      await expect(service.submit(DRIVER_ID, NOW)).resolves.toBeDefined();
    });

    it('refuses an incomplete application with what is missing (422)', async () => {
      runCheck(driver({ drivingLicenceExpiresOn: '2028-05-31' }), [document('selfie')]);
      await expect(service.submit(DRIVER_ID, NOW)).rejects.toMatchObject({
        statusCode: 422,
        error: 'ApplicationIncomplete',
        details: {
          missingFields: ['nationalIdNumber', 'vehicleLicenceExpiresOn'],
          missingDocuments: ['national-id-front', 'national-id-back', 'driving-licence', 'vehicle-licence'],
          expiredLicences: [],
        },
      });
    });

    it('refuses a licence that expired after it was saved', async () => {
      runCheck(complete(), allDocuments());
      await expect(service.submit(DRIVER_ID, new Date('2027-02-01T10:00:00Z'))).rejects.toMatchObject({
        error: 'ApplicationIncomplete',
        details: { expiredLicences: ['vehicleLicenceExpiresOn'] },
      });
    });

    it('answers 409 when the application is already submitted', async () => {
      repository.submitIfDraft.mockRejectedValue(new ApplicationLockedError());
      repository.findApplication.mockResolvedValueOnce(driver()).mockResolvedValueOnce(driver({ submittedAt: NOW }));
      await expect(service.submit(DRIVER_ID, NOW)).rejects.toMatchObject({ statusCode: 409, details: { applicationStatus: 'SUBMITTED' } });
    });
  });

  describe('createReadUrl (staff)', () => {
    it('records the read before issuing a five-minute URL', async () => {
      const current = document('national-id-front', 2);
      repository.findCurrentDocumentWithKey.mockResolvedValue(current);

      const result = await service.createReadUrl('staff-1', DRIVER_ID, 'national-id-front');

      expect(repository.recordAccess).toHaveBeenCalledWith({
        staffUserId: 'staff-1',
        driverId: DRIVER_ID,
        documentId: current.id,
        documentType: 'national-id-front',
        documentVersion: 2,
      });
      expect(repository.recordAccess.mock.invocationCallOrder[0]).toBeLessThan(storage.createReadUrl.mock.invocationCallOrder[0]);
      expect(storage.createReadUrl).toHaveBeenCalledWith(current.objectKey);
      expect(result).toEqual({ type: 'national-id-front', version: 2, contentType: 'image/jpeg', url: 'https://signed.example/doc', expiresIn: 300 });
    });

    it('issues no URL when the read cannot be recorded', async () => {
      repository.findCurrentDocumentWithKey.mockResolvedValue(document('selfie'));
      repository.recordAccess.mockRejectedValue(new Error('database down'));
      await expect(service.createReadUrl('staff-1', DRIVER_ID, 'selfie')).rejects.toThrow('database down');
      expect(storage.createReadUrl).not.toHaveBeenCalled();
    });

    it('answers 404 for a document the driver never uploaded', async () => {
      repository.findCurrentDocumentWithKey.mockResolvedValue(null);
      await expect(service.createReadUrl('staff-1', DRIVER_ID, 'selfie')).rejects.toMatchObject({ statusCode: 404 });
      expect(repository.recordAccess).not.toHaveBeenCalled();
    });
  });
});
