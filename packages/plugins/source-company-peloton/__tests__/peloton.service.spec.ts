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

import { PelotonModule, PelotonService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'peloton-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 086 / T04 — `PelotonService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `PelotonService` through `PelotonModule`.
 *   2. `Site.PELOTON === 'peloton'` literal pin.
 *   3. Happy path — fixture with two listings → two `JobPostDto`s,
 *      including regression assertions for variant-21 URL byte-for-
 *      byte pass-through (the **first cohort plugin to use variant
 *      21** — brand-host careers-subdomain with locale-prefix and
 *      multi-segment listing path with trailing slash; locks the
 *      `careers.onepeloton.com/en/all-jobs/?gh_jid=<id>` substring
 *      emit AND the absence of canonical-Greenhouse-host substring
 *      `job-boards.greenhouse.io` in the emitted `jobUrl`), decode-
 *      then-strip pipeline cleanliness, case-symmetric bare-brand
 *      wire `companyName === 'Peloton'` (D-09 omission lock; wire
 *      and slug both 7 bytes), **D-10 application lock with
 *      trailing-padded form** — emitted `title` for the padded
 *      listing equals trimmed form `'Senior Full Stack Software
 *      Engineer, Device Services'` AND byte-distinct from wire
 *      `'Senior Full Stack Software Engineer, Device Services '`
 *      (with trailing pad byte) AND exactly 1 byte shorter (locking
 *      the trailing-pad observable; Peloton's 3.85 % pad rate is
 *      the **new cohort low**).
 *   4. `resultsWanted = 1` against a two-listing fixture caps the response to one.
 *   5. `searchTerm` filters listings by title (case-insensitive,
 *      against the trimmed form — D-10 search guard).
 *   6. `searchTerm` filters listings by department name (case-
 *      insensitive).
 *   7. HTTP 500 → `scrape` resolves to `{ jobs: [] }`, never throws.
 *   8. Empty `data.jobs` → `{ jobs: [] }`.
 */
describe('PelotonService — Spec 086 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through PelotonModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [PelotonModule],
      }).compile();
      const service = moduleRef.get(PelotonService);
      expect(service).toBeInstanceOf(PelotonService);
      await moduleRef.close();
    });

    it('exports the Site.PELOTON = "peloton" enum value', () => {
      expect(Site.PELOTON).toBe('peloton');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PelotonService();
      const input: ScraperInputDto = {
        siteType: [Site.PELOTON],
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const marketing = dto.jobs.find((j) => j.id === 'peloton-7831932');
      expect(marketing).toBeDefined();
      expect(marketing?.site).toBe(Site.PELOTON);
      // D-09 omission lock: case-symmetric wire `'Peloton'`.
      expect(marketing?.companyName).toBe('Peloton');
      expect(marketing?.companyName).toBe(JOBS_PAGE_RAW.jobs[0].company_name);
      expect(marketing?.companyName?.toLowerCase()).toBe('peloton');
      // First-listing title clean — D-10 trim no-op.
      expect(marketing?.title).toBe('Associate Manager, Marketing');
      expect(marketing?.title).toBe(JOBS_PAGE_RAW.jobs[0].title);
      // D-04 lock: variant 21 — brand-host careers-subdomain with
      // locale-prefix and multi-segment listing path with trailing
      // slash, followed by `?gh_jid=<id>`. **First cohort plugin to
      // use variant 21**.
      expect(marketing?.jobUrl).toBe(
        'https://careers.onepeloton.com/en/all-jobs/?gh_jid=7831932',
      );
      expect(marketing?.jobUrl).toContain('careers.onepeloton.com/en/all-jobs/?gh_jid=');
      expect(marketing?.jobUrl).not.toContain('job-boards.greenhouse.io');
      // D-11 first-listing pass-through guard.
      expect(marketing?.department).toBe('Marketing');
      expect(marketing?.department).toBe(JOBS_PAGE_RAW.jobs[0].departments[0].name);
      // Location — Peloton's NYC HQ.
      expect(marketing?.location?.city).toBe('New York, New York');
      expect(marketing?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(marketing?.description).not.toContain('&lt;');
      expect(marketing?.description).not.toContain('&amp;nbsp;');
      expect(marketing?.description).not.toContain('&#39;');
      expect(marketing?.description).not.toContain('<p>');
      expect(marketing?.description).not.toContain('<strong>');
      expect(marketing?.description).toContain('Peloton');
      expect(marketing?.description).toContain('Associate Manager');

      const device = dto.jobs.find((j) => j.id === 'peloton-7842001');
      expect(device).toBeDefined();
      // D-10 application lock — single-trailing-pad form: emitted
      // `title` is the trimmed `'Senior Full Stack Software Engineer,
      // Device Services'` (no trailing pad bytes) AND byte-distinct
      // from the wire form `'Senior Full Stack Software Engineer,
      // Device Services '` AND exactly 1 byte shorter. Peloton's
      // 3.85 % pad rate is the **new cohort low**.
      expect(device?.title).toBe('Senior Full Stack Software Engineer, Device Services');
      expect(device?.title).not.toBe(JOBS_PAGE_RAW.jobs[1].title);
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(
        'Senior Full Stack Software Engineer, Device Services ',
      );
      expect(JOBS_PAGE_RAW.jobs[1].title.endsWith(' ')).toBe(true);
      expect(device?.title.endsWith(' ')).toBe(false);
      expect(device?.title.length).toBe(JOBS_PAGE_RAW.jobs[1].title.length - 1);
      expect(device?.companyName).toBe('Peloton');
      // D-11 second-listing pass-through guard.
      expect(device?.department).toBe('Software');
      expect(device?.department).toBe(JOBS_PAGE_RAW.jobs[1].departments[0].name);
      expect(device?.location?.city).toBe('Remote - United States');
      expect(device?.isRemote).toBe(true);
      // Variant-21 lock for second listing.
      expect(device?.jobUrl).toBe(
        'https://careers.onepeloton.com/en/all-jobs/?gh_jid=7842001',
      );
      expect(device?.jobUrl).toContain('careers.onepeloton.com/en/all-jobs/?gh_jid=');
      expect(device?.jobUrl).not.toContain('job-boards.greenhouse.io');
      expect(device?.description).not.toContain('<p>');
      expect(device?.description).toContain('Peloton');
      expect(device?.description).toContain('Device Services');

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/peloton/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PelotonService();
      const result = await service.scrape({
        siteType: [Site.PELOTON],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of title (against trimmed form — D-10 search guard)', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PelotonService();
      const result = await service.scrape({
        siteType: [Site.PELOTON],
        searchTerm: 'DEVICE',
      } as ScraperInputDto);

      // The search term `'DEVICE'` matches the second listing's
      // trimmed title `'Senior Full Stack Software Engineer, Device
      // Services'`. The first listing's title 'Associate Manager,
      // Marketing' / dept 'Marketing' do not contain 'device', so it
      // filters out.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('peloton-7842001');
      // Lock D-10 application: emitted title is the trimmed form.
      expect(result.jobs[0].title).toBe(
        'Senior Full Stack Software Engineer, Device Services',
      );
      expect(result.jobs[0].title.endsWith(' ')).toBe(false);
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new PelotonService();
      const result = await service.scrape({
        siteType: [Site.PELOTON],
        searchTerm: 'marketing',
      } as ScraperInputDto);

      // Only the first listing has 'Marketing' as its department; the
      // second listing's department 'Software' does not contain
      // 'marketing'.
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('peloton-7831932');
      expect(result.jobs[0].department).toBe('Marketing');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new PelotonService();
      const result = await service.scrape({
        siteType: [Site.PELOTON],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new PelotonService();
      const result = await service.scrape({
        siteType: [Site.PELOTON],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
