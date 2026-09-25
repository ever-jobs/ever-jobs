import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { ScraperInputDto, Site, DescriptionFormat } from '@ever-jobs/models';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockSetHeaders = jest.fn();

jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      post: mockPost,
      setHeaders: mockSetHeaders,
    })),
  };
});

import { BeisenModule, BeisenService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const REGISTER_HTML = fs.readFileSync(path.join(FIXTURE_DIR, 'beisen-register.html'), 'utf8');
const JOBS_ENVELOPE = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'beisen-jobs.json'), 'utf8'));

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Wire the mocks for a successful two-step (register → list) flow. */
function mockHappyPath(): void {
  mockGet.mockResolvedValue({ data: REGISTER_HTML });
  mockPost.mockResolvedValue({ data: clone(JOBS_ENVELOPE) });
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return {
    siteType: [Site.BEISEN],
    companySlug: 'examplecorp',
    resultsWanted: 100,
    ...overrides,
  } as ScraperInputDto;
}

/**
 * Spec 741 / T08 — `BeisenService` unit tests (mocked HTTP, fixture-driven).
 */
describe('BeisenService — Spec 741', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockSetHeaders.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BeisenModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [BeisenModule] }).compile();
      const service = moduleRef.get(BeisenService);
      expect(service).toBeInstanceOf(BeisenService);
      await moduleRef.close();
    });

    it('exports the Site.BEISEN = "beisen" enum value', () => {
      expect(Site.BEISEN).toBe('beisen');
    });
  });

  describe('happy path', () => {
    it('maps all fixture roles to JobPostDto with the expected fields', async () => {
      mockHappyPath();
      const service = new BeisenService();

      const result = await service.scrape(input({ descriptionFormat: DescriptionFormat.MARKDOWN }));

      expect(result.jobs).toHaveLength(3);
      const job = result.jobs.find((j) => j.atsId === '621097372')!;
      expect(job).toBeDefined();
      expect(job.id).toBe('beisen-621097372');
      expect(job.title).toBe('Senior Backend Engineer (J64518)');
      expect(job.site).toBe(Site.BEISEN);
      expect(job.atsType).toBe('beisen');
      expect(job.companyName).toBe('Example Corp'); // BSGlobal.Name, not the slug
      expect(job.jobUrl).toBe('https://examplecorp.zhiye.com/portal/jobs/621097372');
      expect(job.applyUrl).toBe('https://examplecorp.zhiye.com/portal/jobs/621097372');
      expect(job.location?.city).toBe('Shanghai');
      expect(job.location?.state).toBeNull();
      expect(job.location?.country).toBe('China'); // 'China' is a country literal, not a state
      expect(job.department).toBe('社会招聘');
      expect(job.datePosted).toBe('2026-05-07');
      expect(job.description).toContain('scalable backend services');
      expect(job.description).toContain('Education');
    });

    it('resolves the tenant only once for the listing flow (single register GET)', async () => {
      mockHappyPath();
      const service = new BeisenService();
      await service.scrape(input());
      expect(mockGet).toHaveBeenCalledTimes(1); // one register call
      expect(mockPost).toHaveBeenCalled(); // at least one listing page
    });
  });

  describe('tenant resolution', () => {
    it('resolves a tenant from a full *.zhiye.com URL passed as companySlug', async () => {
      mockHappyPath();
      const service = new BeisenService();
      const result = await service.scrape(
        input({ companySlug: 'https://examplecorp.zhiye.com/social/jobs' }),
      );
      expect(result.jobs.length).toBeGreaterThan(0);
      expect(result.jobs[0].jobUrl).toContain('examplecorp.zhiye.com');
    });

    it('resolves a tenant from companyUrl', async () => {
      mockHappyPath();
      const service = new BeisenService();
      const result = await service.scrape(
        input({ companySlug: undefined, companyUrl: 'https://examplecorp.zhiye.com/portal/jobs' }),
      );
      expect(result.jobs.length).toBeGreaterThan(0);
    });

    it('returns empty when neither companySlug nor companyUrl is provided', async () => {
      const service = new BeisenService();
      const result = await service.scrape(input({ companySlug: undefined, companyUrl: undefined }));
      expect(result.jobs).toHaveLength(0);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('returns empty for a non-zhiye.com companyUrl host', async () => {
      const service = new BeisenService();
      const result = await service.scrape(
        input({ companySlug: undefined, companyUrl: 'https://careers.example.com/jobs' }),
      );
      expect(result.jobs).toHaveLength(0);
    });
  });

  describe('graceful degradation', () => {
    it('returns empty when the page exposes no BSGlobal block', async () => {
      mockGet.mockResolvedValue({ data: '<html><head><title>no config</title></head></html>' });
      const service = new BeisenService();
      const result = await service.scrape(input());
      expect(result.jobs).toHaveLength(0);
      expect(mockPost).not.toHaveBeenCalled(); // never reaches the listing step
    });

    it('returns empty when BSGlobal carries no PortalId', async () => {
      mockGet.mockResolvedValue({
        data: '<script>var BSGlobal = {"Key":"k","Name":"X","Code":"t10"};</script>',
      });
      const service = new BeisenService();
      const result = await service.scrape(input());
      expect(result.jobs).toHaveLength(0);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('returns empty on an HTTP error fetching the register page', async () => {
      mockGet.mockRejectedValue({ response: { status: 404 }, message: 'Not Found' });
      const service = new BeisenService();
      const result = await service.scrape(input());
      expect(result.jobs).toHaveLength(0);
    });

    it('returns empty on a transport failure fetching the register page', async () => {
      mockGet.mockRejectedValue({ message: 'ECONNREFUSED' });
      const service = new BeisenService();
      const result = await service.scrape(input());
      expect(result.jobs).toHaveLength(0);
    });

    it('returns empty when the listing body is malformed', async () => {
      mockGet.mockResolvedValue({ data: REGISTER_HTML });
      mockPost.mockResolvedValue({ data: 'definitely not json' });
      const service = new BeisenService();
      const result = await service.scrape(input());
      expect(result.jobs).toHaveLength(0);
    });

    it('returns empty for a tenant with no open roles', async () => {
      mockGet.mockResolvedValue({ data: REGISTER_HTML });
      mockPost.mockResolvedValue({ data: { Code: 200, Count: 0, Data: [] } });
      const service = new BeisenService();
      const result = await service.scrape(input());
      expect(result.jobs).toHaveLength(0);
    });

    it('returns partial results when listing pages fail at the transport level', async () => {
      mockGet.mockResolvedValue({ data: REGISTER_HTML });
      mockPost.mockRejectedValue({ message: 'socket hang up' });
      const service = new BeisenService();
      const result = await service.scrape(input());
      expect(result.jobs).toHaveLength(0); // host down before any page returned
    });
  });

  describe('field handling', () => {
    it('caps results at resultsWanted', async () => {
      mockHappyPath();
      const service = new BeisenService();
      const result = await service.scrape(input({ resultsWanted: 1 }));
      expect(result.jobs).toHaveLength(1);
    });

    it('treats the 0001-01-01 unset date as missing and falls back to PostDate', async () => {
      mockHappyPath();
      const service = new BeisenService();
      const result = await service.scrape(input());
      const remote = result.jobs.find((j) => j.atsId === '621097400')!;
      expect(remote.datePosted).toBe('2026-05-01'); // ChangeDate was 0001-01-01 → ignored
    });

    it('flags remote roles (English + 远程)', async () => {
      mockHappyPath();
      const service = new BeisenService();
      const result = await service.scrape(input());
      const remote = result.jobs.find((j) => j.atsId === '621097400')!;
      expect(remote.isRemote).toBe(true);
    });

    it('de-slugifies the company name when BSGlobal has no Name', async () => {
      mockGet.mockResolvedValue({
        data: '<script>var BSGlobal = {"PortalId":"p-123"};</script>',
      });
      mockPost.mockResolvedValue({ data: clone(JOBS_ENVELOPE) });
      const service = new BeisenService();
      const result = await service.scrape(input({ companySlug: 'acme-foods' }));
      expect(result.jobs[0].companyName).toBe('Acme Foods');
    });
  });
});
