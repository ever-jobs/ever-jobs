import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { PluginRegistry } from '@ever-jobs/plugin';
import { LeverService } from '@ever-jobs/source-ats-lever';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({
      get: mockGet,
      post: jest.fn(),
      setHeaders: jest.fn(),
    })),
  };
});

import { KnixModule, KnixService } from '../src';

const COMPANY_NAME_EXPECT = 'Knix';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
// Lever's public Postings API returns a bare array of postings.
const JOBS_PAGE_RAW: any[] = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'knix-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Registry wired with a real LeverService registered under Site.LEVER. */
function registryWithLever(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register(
    { site: Site.LEVER, name: 'Lever', category: 'ats', isAts: true },
    new LeverService(),
  );
  return registry;
}

describe('KnixService — Lever delegation', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through KnixModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [KnixModule],
      }).compile();
      const service = moduleRef.get(KnixService);
      expect(service).toBeInstanceOf(KnixService);
      await moduleRef.close();
    });

    it('exports the Site.KNIX = "knix" enum value', () => {
      expect(Site.KNIX).toBe('knix');
    });
  });

  describe('happy path (delegates to the registered Lever plugin)', () => {
    it('maps all fixture listings to JobPostDto with the company identity', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new KnixService(registryWithLever());
      const result = (await service.scrape({
        siteType: [Site.KNIX],
        resultsWanted: 100,
      } as ScraperInputDto)) as JobResponseDto;

      expect(result.jobs).toHaveLength(JOBS_PAGE_RAW.length);

      const first = JOBS_PAGE_RAW[0];
      const job0 = result.jobs.find(
        (j) => j.id === 'knix-' + first.id,
      );
      expect(job0).toBeDefined();
      // company identity is re-stamped over Lever's defaults
      expect(job0?.site).toBe(Site.KNIX);
      expect(job0?.companyName).toBe(COMPANY_NAME_EXPECT);
      expect(job0?.id).toBe('knix-' + first.id);
      expect(job0?.id?.startsWith('lever-')).toBe(false);
      // Lever-mapped fields flow through untouched
      expect(job0?.title).toBe(first.text);
      expect(job0?.jobUrl).toBe(first.hostedUrl);
      expect(job0?.department).toBe(first.categories.department);

      // it hit the Lever board for the company slug, not Greenhouse/Ashby
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toContain('api.lever.co/v0/postings');
      expect(calledUrls[0]).toContain('knix');
      expect(calledUrls[0]).not.toContain('greenhouse');
      expect(calledUrls[0]).not.toContain('ashby');
    });

    it('every job carries the company site, companyName, and id prefix', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new KnixService(registryWithLever());
      const result = await service.scrape({
        siteType: [Site.KNIX],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.site).toBe(Site.KNIX);
        expect(job.companyName).toBe(COMPANY_NAME_EXPECT);
        expect(job.id?.startsWith('knix-')).toBe(true);
      }
    });
  });

  describe('input pass-through', () => {
    it('forwards the company slug and caller input to the Lever scraper', async () => {
      const captured: ScraperInputDto[] = [];
      const fakeLever: IScraper = {
        scrape: async (input) => {
          captured.push(input);
          return new JobResponseDto([
            new JobPostDto({ id: 'lever-x1', title: 'Role', jobUrl: 'u' }),
          ]);
        },
      };
      const registry = new PluginRegistry();
      registry.register(
        { site: Site.LEVER, name: 'Lever', category: 'ats', isAts: true },
        fakeLever,
      );

      const service = new KnixService(registry);
      const result = await service.scrape({
        siteType: [Site.KNIX],
        resultsWanted: 7,
      } as ScraperInputDto);

      expect(captured).toHaveLength(1);
      expect(captured[0].companySlug).toBe('knix');
      expect(captured[0].resultsWanted).toBe(7);
      expect(result.jobs[0].id).toBe('knix-x1');
      expect(result.jobs[0].site).toBe(Site.KNIX);
    });

    it('only rewrites a leading lever- id prefix', async () => {
      const fakeLever: IScraper = {
        scrape: async () =>
          new JobResponseDto([
            new JobPostDto({ id: 'lever-lever-7', title: 'T', jobUrl: 'u' }),
          ]),
      };
      const registry = new PluginRegistry();
      registry.register(
        { site: Site.LEVER, name: 'Lever', category: 'ats', isAts: true },
        fakeLever,
      );
      const service = new KnixService(registry);
      const result = await service.scrape({
        siteType: [Site.KNIX],
      } as ScraperInputDto);
      expect(result.jobs[0].id).toBe('knix-lever-7');
    });
  });

  describe('resilience', () => {
    it('returns an empty response when no Lever plugin is registered', async () => {
      const service = new KnixService(new PluginRegistry());
      const result = await service.scrape({
        siteType: [Site.KNIX],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });

    it('returns an empty response when no registry is injected', async () => {
      const service = new KnixService();
      const result = await service.scrape({
        siteType: [Site.KNIX],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that distinguishes a wiring fault from an empty board.
      expect(result.diagnostics?.reason).toBe('not_registered');
      expect(result.diagnostics?.detail).toContain('Lever');
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against the fixture page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new KnixService(registryWithLever());
      const result = await service.scrape({
        siteType: [Site.KNIX],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });
});
