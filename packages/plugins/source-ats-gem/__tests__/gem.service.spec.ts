import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { JobResponseDto, ScraperInputDto, Site } from '@ever-jobs/models';

// Mock createHttpClient so the scraper hits a controlled fixture
// pipeline instead of jobs.gem.com.
const mockPost = jest.fn();
const mockSetHeaders = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      post: mockPost,
      setHeaders: mockSetHeaders,
    })),
  };
});

import { GemModule, GemService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const BATCH_RESPONSE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'gem-batch-response.json'), 'utf8'),
) as unknown[];

/**
 * Spec 006 / T06 — `GemService` GraphQL-batch unit tests.
 *
 * The fixture (`gem-batch-response.json`) carries 3 postings under
 * a happy-path response shape. Each test mutates that fixture in
 * isolation (deep-clone via `JSON.parse(JSON.stringify(...))`) so
 * one case never bleeds into another.
 *
 * Coverage (≥ 4 cases mandated by `tasks.md`):
 *   1. **Happy path** — full fixture → 3 `JobPostDto` rows with the
 *      canonical `gem-${extId}` id, company name resolved from
 *      `jobBoardExternal.teamDisplayName`, remote detection from
 *      `locations[0].isRemote`, department from `job.department.name`.
 *   2. **Empty `jobPostings`** — happy fixture but with the
 *      array empty → empty `JobResponseDto`, no throw.
 *   3. **HTTP 500 caught** — `mockPost` rejects → empty
 *      `JobResponseDto`, no rethrow.
 *   4. **Response-order tolerance** — fixture with the two batch
 *      envelopes swapped (List first, Theme second) → still
 *      yields 3 postings (parser walks the array, doesn't trust
 *      `data[1]`).
 *
 * Plus 3 carry-over scaffolding cases (T02 → T06):
 *   5. NestJS DI resolution via `GemModule`.
 *   6. `Site.GEM === 'gem'` literal pin.
 *   7. Missing `companySlug` → empty `JobResponseDto`, no
 *      `mockPost` invocation.
 *
 * 7 cases total. Behavioural failure modes that need wider
 * coverage (full pagination, descriptions HTML→plain, multi-location
 * row mapping) are deferred until the upstream Python reference
 * adds them — currently it surfaces only one location per posting,
 * matching what we map.
 */

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('GemService — Spec 006 / T05 + T06', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockSetHeaders.mockReset();
    // Default: detail (ExternalJobPostingQuery) calls return an empty
    // envelope so a test that only seeds the list response still has
    // every per-posting detail fetch resolve cleanly (to null detail).
    mockPost.mockResolvedValue({ data: [] });
  });

  describe('registration scaffolding (carries forward from T02)', () => {
    it('resolves through GemModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [GemModule],
      }).compile();
      const service = moduleRef.get(GemService);
      expect(service).toBeInstanceOf(GemService);
      await moduleRef.close();
    });

    it('exports the Site.GEM = "gem" enum value', () => {
      expect(Site.GEM).toBe('gem');
    });

    it('returns empty JobResponseDto when companySlug is unset', async () => {
      const service = new GemService();
      const result = await service.scrape({} as ScraperInputDto);
      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toEqual([]);
      expect(mockPost).not.toHaveBeenCalled();
    });
  });

  describe('happy path — 3 postings', () => {
    it('maps every posting to a canonical JobPostDto with company / location / department', async () => {
      mockPost.mockResolvedValueOnce({ data: clone(BATCH_RESPONSE_RAW) });

      const service = new GemService();
      const input: ScraperInputDto = {
        siteType: [Site.GEM],
        companySlug: 'acme',
        resultsWanted: 100,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toHaveLength(3);

      const first = result.jobs[0];
      expect(first.id).toBe('gem-ext-1001');
      expect(first.title).toBe('Staff Software Engineer');
      expect(first.companyName).toBe('Acme Corp');
      expect(first.atsType).toBe('gem');
      expect(first.atsId).toBe('ext-1001');
      expect(first.site).toBe(Site.GEM);
      expect(first.jobUrl).toBe('https://jobs.gem.com/acme/ext-1001');
      expect(first.location?.city).toBe('New York, NY');
      expect(first.department).toBe('Engineering');
      expect(first.isRemote).toBe(false);
      // employmentType is humanised from the list `job.employmentType` enum.
      expect(first.employmentType).toBe('Full-time');

      // Remote-detection sanity check on the SRE row.
      const sre = result.jobs.find((j) => j.atsId === 'ext-1002');
      expect(sre?.isRemote).toBe(true);
      expect(sre?.location?.city).toBe('Remote — US');

      // Hybrid → not flagged as remote.
      const designer = result.jobs.find((j) => j.atsId === 'ext-1003');
      expect(designer?.isRemote).toBe(false);
      expect(designer?.department).toBe('Design');

      // Verify the list request: the first POST carries both operations
      // in the canonical order (Theme first, List second), boardId =
      // companySlug. (Per-posting detail POSTs follow.)
      const [url, payload] = mockPost.mock.calls[0];
      expect(url).toBe('https://jobs.gem.com/api/public/graphql/batch');
      expect(Array.isArray(payload)).toBe(true);
      expect(payload).toHaveLength(2);
      expect(payload[0].operationName).toBe('JobBoardTheme');
      expect(payload[1].operationName).toBe('JobBoardList');
      expect(payload[0].variables).toEqual({ boardId: 'acme' });
      expect(payload[1].variables).toEqual({ boardId: 'acme' });
    });

    it('honours resultsWanted=2 against a 3-posting fixture', async () => {
      mockPost.mockResolvedValueOnce({ data: clone(BATCH_RESPONSE_RAW) });

      const service = new GemService();
      const input: ScraperInputDto = {
        siteType: [Site.GEM],
        companySlug: 'acme',
        resultsWanted: 2,
      } as ScraperInputDto;

      const result = await service.scrape(input);
      expect(result.jobs).toHaveLength(2);
    });
  });

  describe('detail overlay', () => {
    it('overlays description, datePosted, compensation and maps employmentType + URL', async () => {
      // Route by operation: the list POST returns the batch fixture; each
      // ExternalJobPostingQuery returns a per-extId detail envelope.
      const details: Record<string, any> = {
        'ext-1001': {
          descriptionHtml: '<p>Build <b>flight</b> avionics.</p>',
          firstPublishedTsSec: 1756568058,
          startDateTs: null,
          compensationHtml:
            '<h2>Compensation</h2><div>The base pay range is $170,000 – $200,000 per year.</div>',
        },
      };
      mockPost.mockImplementation(async (_url: string, payload: any[]) => {
        const op = payload?.[0]?.operationName;
        if (op === 'ExternalJobPostingQuery') {
          const extId = payload[0].variables.extId as string;
          return { data: [{ data: { oatsExternalJobPosting: details[extId] ?? null } }] };
        }
        return { data: clone(BATCH_RESPONSE_RAW) };
      });

      const service = new GemService();
      const result = await service.scrape({
        siteType: [Site.GEM],
        companySlug: 'acme',
        resultsWanted: 100,
      } as ScraperInputDto);

      const first = result.jobs.find((j) => j.atsId === 'ext-1001');
      expect(first?.jobUrl).toBe('https://jobs.gem.com/acme/ext-1001');
      // Body is overlaid from the detail (markdown by default).
      expect(first?.description).toContain('Build');
      expect(first?.description).toContain('flight');
      // datePosted comes from firstPublishedTsSec (Unix seconds → Date).
      expect(first?.datePosted).toEqual(new Date(1756568058 * 1000));
      // Free-text compensationHtml is parsed into a structured range.
      expect(first?.compensation?.minAmount).toBe(170000);
      expect(first?.compensation?.maxAmount).toBe(200000);
      expect(first?.employmentType).toBe('Full-time');

      // A posting with no detail node keeps its list-only fields (no body/date).
      const noDetail = result.jobs.find((j) => j.atsId === 'ext-1002');
      expect(noDetail?.description ?? null).toBeNull();
      expect(noDetail?.datePosted ?? null).toBeNull();
      expect(noDetail?.title).toBe('Remote Site Reliability Engineer');
    });
  });

  describe('empty jobPostings', () => {
    it('returns an empty JobResponseDto without throwing', async () => {
      const empty = clone(BATCH_RESPONSE_RAW);
      // Walk the structure to set jobPostings: [] without breaking
      // the test if the fixture order ever flips.
      const listEnv = (empty as any[]).find(
        (e) => e?.data?.oatsExternalJobPostings !== undefined,
      );
      expect(listEnv).toBeDefined();
      listEnv.data.oatsExternalJobPostings.jobPostings = [];
      mockPost.mockResolvedValueOnce({ data: empty });

      const service = new GemService();
      const result = await service.scrape({
        siteType: [Site.GEM],
        companySlug: 'acme',
      } as ScraperInputDto);

      expect(result).toBeInstanceOf(JobResponseDto);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('HTTP 500 caught', () => {
    it('returns an empty JobResponseDto on rejection (never re-throws)', async () => {
      mockPost.mockRejectedValueOnce(new Error('Request failed with status 500'));
      const service = new GemService();
      await expect(
        service.scrape({
          siteType: [Site.GEM],
          companySlug: 'acme',
        } as ScraperInputDto),
      ).resolves.toBeInstanceOf(JobResponseDto);

      mockPost.mockRejectedValueOnce(new Error('socket hang up'));
      const result = await service.scrape({
        siteType: [Site.GEM],
        companySlug: 'acme',
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('response-order tolerance', () => {
    it('finds JobBoardList envelope when the server reorders (List first, Theme second)', async () => {
      // Reverse the array: List envelope first, Theme second.
      const reordered = clone(BATCH_RESPONSE_RAW).reverse();
      mockPost.mockResolvedValueOnce({ data: reordered });

      const service = new GemService();
      const result = await service.scrape({
        siteType: [Site.GEM],
        companySlug: 'acme',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(3);
      // Sanity: the first posting still maps to ext-1001 regardless
      // of envelope order.
      expect(result.jobs[0].atsId).toBe('ext-1001');
    });

    it('returns empty JobResponseDto when no envelope carries oatsExternalJobPostings', async () => {
      // Both envelopes only carry theme data — no JobBoardList
      // shape. Parser MUST NOT crash, MUST return empty.
      mockPost.mockResolvedValueOnce({
        data: [
          { data: { publicBrandingTheme: { id: 'a', theme: '{}' } } },
          { data: { publicBrandingTheme: { id: 'b', theme: '{}' } } },
        ],
      });

      const service = new GemService();
      const result = await service.scrape({
        siteType: [Site.GEM],
        companySlug: 'acme',
      } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
    });
  });
});
