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

import { AdaptiveBiotechnologiesModule, AdaptiveBiotechnologiesService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'adaptivebiotechnologies-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 187 / T04 — `AdaptiveBiotechnologiesService` unit tests.
 *
 * Coverage (>= 9 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `AdaptiveBiotechnologiesService` through `AdaptiveBiotechnologiesModule`.
 *   2. `Site.ADAPTIVEBIOTECHNOLOGIES === 'adaptivebiotechnologies'` literal pin.
 *   3. Happy path — D-04 NEW variant-47 URL pass-through;
 *      D-09 2-token PascalCase byte-for-byte wire pin
 *      (`'Adaptive Biotechnologies'` 24 bytes); D-10
 *      trailing-pad title-trim lock; D-11 clean dept pass-
 *      through lock.
 *   4. D-09 explicit byte-for-byte 2-token PascalCase wire
 *      lock + case-symmetric slug derivation lock (space-
 *      strip + lowercase → 23-byte slug `adaptivebiotechnologies`).
 *   5. D-04 explicit NEW variant-47 URL lock — wire host
 *      `www.adaptivebiotech.com`, 2-segment
 *      `/career-listings/listing` apply-page path without
 *      trailing slash, single-id `?gh_jid=<id>` query.
 *   6. D-10 explicit trailing-pad title-trim lock (no emitted
 *      title ends in whitespace).
 *   7. D-11 explicit clean-pass-through dept lock.
 *   8..10. resultsWanted, searchTerm filters, error
 *      handling, empty payload.
 */
describe('AdaptiveBiotechnologiesService — Spec 187 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through AdaptiveBiotechnologiesModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AdaptiveBiotechnologiesModule],
      }).compile();
      const service = moduleRef.get(AdaptiveBiotechnologiesService);
      expect(service).toBeInstanceOf(AdaptiveBiotechnologiesService);
      await moduleRef.close();
    });

    it('exports the Site.ADAPTIVEBIOTECHNOLOGIES = "adaptivebiotechnologies" enum value', () => {
      expect(Site.ADAPTIVEBIOTECHNOLOGIES).toBe('adaptivebiotechnologies');
    });
  });

  describe('happy path — 3 listings mapped to JobPostDto', () => {
    it('maps all fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdaptiveBiotechnologiesService();
      const result = await service.scrape({
        siteType: [Site.ADAPTIVEBIOTECHNOLOGIES],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(3);

      const ac = dto.jobs.find((j) => j.id === 'adaptivebiotechnologies-8503018002');
      expect(ac).toBeDefined();
      expect(ac?.site).toBe(Site.ADAPTIVEBIOTECHNOLOGIES);
      // D-09 2-token PascalCase wire lock.
      expect(ac?.companyName).toBe('Adaptive Biotechnologies');
      expect(ac?.companyName).toHaveLength(24);
      expect(ac?.title).toBe('Accessioning Specialist II');
      // D-04 NEW variant-47 URL lock.
      expect(ac?.jobUrl).toBe(
        'https://www.adaptivebiotech.com/career-listings/listing?gh_jid=8503018002',
      );
      expect(ac?.jobUrl).toContain('www.adaptivebiotech.com/career-listings/listing');
      expect(ac?.jobUrl).toContain('?gh_jid=8503018002');
      // D-11 clean dept pass-through.
      expect(ac?.department).toBe('Laboratory Operations');
      expect(ac?.location?.city).toBe('Seattle');
      expect(ac?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ac?.description).not.toContain('&lt;');
      expect(ac?.description).not.toContain('&amp;');
      expect(ac?.description).not.toContain('<p>');
      expect(ac?.description).toContain('Adaptive Biotechnologies');

      const ct = dto.jobs.find((j) => j.id === 'adaptivebiotechnologies-8496748002');
      expect(ct).toBeDefined();
      // D-10 lock — wire title carries trailing-pad; emitted
      // title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe('Clinical Lab Technologist II ');
      expect(ct?.title).toBe('Clinical Lab Technologist II');
      expect(ct?.title).not.toMatch(/\s$/);
      expect(ct?.companyName).toBe('Adaptive Biotechnologies');
      expect(ct?.department).toBe('Laboratory Operations');

      const ao = dto.jobs.find((j) => j.id === 'adaptivebiotechnologies-8527538002');
      expect(ao).toBeDefined();
      expect(ao?.title).toBe('Account Operations Manager - Southeast');
      expect(ao?.companyName).toBe('Adaptive Biotechnologies');
      expect(ao?.department).toBe('Commercial Operations');
      expect(ao?.location?.city).toBe('Remote (WFH)');
      expect(ao?.isRemote).toBe(true);

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/adaptivebiotechnologies/jobs?content=true',
      );
    });
  });

  describe('D-09 byte-for-byte lock + case-symmetric slug derivation lock', () => {
    it('preserves wire company_name byte-for-byte — 2-token PascalCase 24-byte wire form', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdaptiveBiotechnologiesService();
      const result = await service.scrape({
        siteType: [Site.ADAPTIVEBIOTECHNOLOGIES],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.companyName).toBe('Adaptive Biotechnologies');
        expect(job.companyName).toHaveLength(24);
      }
      const wire = 'Adaptive Biotechnologies';
      const tokens = wire.split(' ');
      expect(tokens).toHaveLength(2);
      expect(tokens).toEqual(['Adaptive', 'Biotechnologies']);
      for (const tok of tokens) {
        expect(tok[0]).toMatch(/[A-Z]/);
        expect(tok.slice(1)).toMatch(/^[a-z]+$/);
      }
      // Case-symmetric slug derivation: space-strip +
      // lowercase → 23-byte slug.
      const slug = wire.replace(/ /g, '').toLowerCase();
      expect(slug).toBe('adaptivebiotechnologies');
      expect(slug).toHaveLength(23);
      expect(slug).toBe(Site.ADAPTIVEBIOTECHNOLOGIES);
    });
  });

  describe('D-04 NEW variant-47 URL lock', () => {
    it('emits wire absolute_url byte-for-byte — custom truncated-brand-domain + 2-segment path + single-id query', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdaptiveBiotechnologiesService();
      const result = await service.scrape({
        siteType: [Site.ADAPTIVEBIOTECHNOLOGIES],
      } as ScraperInputDto);

      for (const job of result.jobs) {
        expect(job.jobUrl).toMatch(
          /^https:\/\/www\.adaptivebiotech\.com\/career-listings\/listing\?gh_jid=\d+$/,
        );
        // No trailing slash after `listing` segment.
        expect(job.jobUrl).not.toContain('/listing/?');
        // Single-id query — no `?job=` dual-id form.
        expect(job.jobUrl).not.toContain('?job=');
        // Truncated-brand domain — drop `nologies` from
        // `biotechnologies`.
        expect(job.jobUrl).toContain('adaptivebiotech.com');
        expect(job.jobUrl).not.toContain('adaptivebiotechnologies.com');
      }
    });
  });

  describe('D-10 trailing-pad title-trim lock', () => {
    it('trims trailing ASCII-space padding from wire titles — no emitted title ends in whitespace', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdaptiveBiotechnologiesService();
      const result = await service.scrape({
        siteType: [Site.ADAPTIVEBIOTECHNOLOGIES],
      } as ScraperInputDto);

      // Wire fixture carries the padded form on listing[1].
      expect(JOBS_PAGE_RAW.jobs[1].title).toMatch(/\s$/);
      // Emitted titles are all .trim()'d.
      for (const job of result.jobs) {
        expect(job.title).not.toMatch(/\s$/);
        expect(job.title).not.toMatch(/^\s/);
      }
    });
  });

  describe('D-11 clean-pass-through lock', () => {
    it('emits department byte-equal to wire departments[0].name (no .trim() overlay)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdaptiveBiotechnologiesService();
      const result = await service.scrape({
        siteType: [Site.ADAPTIVEBIOTECHNOLOGIES],
      } as ScraperInputDto);

      for (let i = 0; i < result.jobs.length; i++) {
        const wireDept = JOBS_PAGE_RAW.jobs[i].departments[0].name;
        expect(result.jobs[i].department).toBe(wireDept);
        expect(wireDept).not.toMatch(/\s$/);
        expect(wireDept).not.toMatch(/^\s/);
      }
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 3-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdaptiveBiotechnologiesService();
      const result = await service.scrape({
        siteType: [Site.ADAPTIVEBIOTECHNOLOGIES],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdaptiveBiotechnologiesService();
      const result = await service.scrape({
        siteType: [Site.ADAPTIVEBIOTECHNOLOGIES],
        searchTerm: 'accessioning',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('adaptivebiotechnologies-8503018002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new AdaptiveBiotechnologiesService();
      const result = await service.scrape({
        siteType: [Site.ADAPTIVEBIOTECHNOLOGIES],
        searchTerm: 'COMMERCIAL',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('adaptivebiotechnologies-8527538002');
      expect(result.jobs[0].department).toBe('Commercial Operations');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new AdaptiveBiotechnologiesService();
      const result = await service.scrape({
        siteType: [Site.ADAPTIVEBIOTECHNOLOGIES],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new AdaptiveBiotechnologiesService();
      const result = await service.scrape({
        siteType: [Site.ADAPTIVEBIOTECHNOLOGIES],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
