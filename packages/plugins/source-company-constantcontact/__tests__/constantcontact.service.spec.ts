import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      setHeaders: jest.fn(),
    })),
  };
});

import { ConstantContactModule, ConstantContactService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'constantcontact-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 111 / T04 — `ConstantContactService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `ConstantContactService` through `ConstantContactModule`.
 *   2. `Site.CONSTANTCONTACT === 'constantcontact'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; D-09 internal-
 *      whitespace asymmetry lock; D-10 trailing-pad title trim;
 *      D-11 numeric-prefix dept pass-through (first cohort
 *      observation).
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('ConstantContactService — Spec 111 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through ConstantContactModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ConstantContactModule],
      }).compile();
      const service = moduleRef.get(ConstantContactService);
      expect(service).toBeInstanceOf(ConstantContactService);
      await moduleRef.close();
    });

    it('exports the Site.CONSTANTCONTACT = "constantcontact" enum value', () => {
      expect(Site.CONSTANTCONTACT).toBe('constantcontact');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ConstantContactService();
      const result = await service.scrape({
        siteType: [Site.CONSTANTCONTACT],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ai = dto.jobs.find((j) => j.id === 'constantcontact-7394405');
      expect(ai).toBeDefined();
      expect(ai?.site).toBe(Site.CONSTANTCONTACT);
      // D-09 internal-whitespace lock.
      expect(ai?.companyName).toBe('Constant Contact');
      expect(ai?.companyName?.length).toBe(16);
      expect(ai?.companyName).toContain(' ');
      expect(ai?.companyName?.replace(/ /g, '').toLowerCase()).toBe('constantcontact');
      // D-10 lock — wire title carries trailing-space pad;
      // emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[0].title).toBe('AI Solutions Engineer ');
      expect(ai?.title).toBe('AI Solutions Engineer');
      expect(ai?.title).not.toMatch(/\s$/);
      // D-04 lock — variant 2.
      expect(ai?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/constantcontact/jobs/7394405',
      );
      expect(ai?.jobUrl).toContain('job-boards.greenhouse.io/constantcontact/jobs/');
      // **D-11 lock — first-cohort numeric-prefix department
      // names**: emitted department `'100 Engineering'` byte-for-
      // byte (numeric organizational ID + name).
      expect(ai?.department).toBe('100 Engineering');
      expect(ai?.department).toMatch(/^\d+ /);
      expect(ai?.location?.city).toBe('Waterloo, CA');
      expect(ai?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ai?.description).not.toContain('&lt;');
      expect(ai?.description).not.toContain('&amp;');
      expect(ai?.description).not.toContain('<p>');
      expect(ai?.description).not.toContain('<strong>');
      expect(ai?.description).toContain('Constant Contact');

      const spd = dto.jobs.find((j) => j.id === 'constantcontact-7762092');
      expect(spd).toBeDefined();
      expect(spd?.title).toBe('Senior Product Designer');
      expect(spd?.companyName).toBe('Constant Contact');
      expect(spd?.location?.city).toBe('Waltham, MA');
      expect(spd?.isRemote).toBe(false);
      expect(spd?.department).toBe('126 Design');
      expect(spd?.department).toMatch(/^\d+ /);
      expect(spd?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/constantcontact/jobs/7762092',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/constantcontact/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ConstantContactService();
      const result = await service.scrape({
        siteType: [Site.CONSTANTCONTACT],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ConstantContactService();
      const result = await service.scrape({
        siteType: [Site.CONSTANTCONTACT],
        searchTerm: 'DESIGNER',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('constantcontact-7762092');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new ConstantContactService();
      const result = await service.scrape({
        siteType: [Site.CONSTANTCONTACT],
        searchTerm: 'engineering',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('constantcontact-7394405');
      expect(result.jobs[0].department).toBe('100 Engineering');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new ConstantContactService();
      const result = await service.scrape({
        siteType: [Site.CONSTANTCONTACT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new ConstantContactService();
      const result = await service.scrape({
        siteType: [Site.CONSTANTCONTACT],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
