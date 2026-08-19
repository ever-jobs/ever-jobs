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

import { WatchGuardTechnologiesModule, WatchGuardTechnologiesService } from '../src';

const COMPANY_NAME_EXPECT = 'WatchGuard Technologies';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
// Lever's public Postings API returns a bare array of postings.
const JOBS_PAGE_RAW: any[] = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'watchguard-jobs.json'), 'utf8'),
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

describe('WatchGuardTechnologiesService — Lever delegation', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through WatchGuardTechnologiesModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [WatchGuardTechnologiesModule],
      }).compile();
      const service = moduleRef.get(WatchGuardTechnologiesService);
      expect(service).toBeInstanceOf(WatchGuardTechnologiesService);
      await moduleRef.close();
    });

    it('exports the Site.WATCHGUARD_TECHNOLOGIES = "watchguard" enum value', () => {
      expect(Site.WATCHGUARD_TECHNOLOGIES).toBe('watchguard');
    });
  });

  describe('happy path (delegates to the registered Lever plugin)', () => {
    it('maps all fixture listings to JobPostDto with the company identity', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new WatchGuardTechnologiesService(registryWithLever());
      const result = (await service.scrape({
        siteType: [Site.WATCHGUARD_TECHNOLOGIES],
        resultsWanted: 100,
      } as ScraperInputDto)) as JobResponseDto;

      expect(result.jobs).toHaveLength(JOBS_PAGE_RAW.length);

      const first = JOBS_PAGE_RAW[0];
      const job0 = result.jobs.find(
        (j) => j.id === 'watchguard-' + first.id,
      );
      expect(job0).toBeDefined();
      // company identity is re-stamped over Lever's defaults
      expect(job0?.site).toBe(Site.WATCHGUARD_TECHNOLOGIES);
      expect(job0?.companyName).toBe(COMPANY_NAME_EXPECT);
      expect(job0?.id).toBe('watchguard-' + first.id);
      expect(job0?.id?.startsWith('lever-')).toBe(false);
      // Lever-mapped fields flow through untouched
      expect(job0?.title).toBe(first.text);
      expect(job0?.jobUrl).toBe(first.hostedUrl);
      expect(job0?.department).toBe(first.categories.department);

      // it hit the Lever board for the company slug, not Greenhouse/Ashby
      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toContain('api.lever.co/v0/postings');
      expect(calledUrls[0]).toContain('watchguard');
      expect(calledUrls[0]).not.toContain('greenhouse');
      expect(calledUrls[0]).not.toContain('ashby');
    });

    it('every job carries the company site, companyName, and id prefix', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });
      const service = new WatchGuardTechnologiesService(registryWithLever());
      const result = await service.scrape({
        siteType: [Site.WATCHGUARD_TECHNOLOGIES],
      } as ScraperInputDto);
      for (const job of result.jobs) {
        expect(job.site).toBe(Site.WATCHGUARD_TECHNOLOGIES);
        expect(job.companyName).toBe(COMPANY_NAME_EXPECT);
        expect(job.id?.startsWith('watchguard-')).toBe(true);
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

      const service = new WatchGuardTechnologiesService(registry);
      const result = await service.scrape({
        siteType: [Site.WATCHGUARD_TECHNOLOGIES],
        resultsWanted: 7,
      } as ScraperInputDto);

      expect(captured).toHaveLength(1);
      expect(captured[0].companySlug).toBe('watchguard');
      expect(captured[0].resultsWanted).toBe(7);
      expect(result.jobs[0].id).toBe('watchguard-x1');
      expect(result.jobs[0].site).toBe(Site.WATCHGUARD_TECHNOLOGIES);
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
      const service = new WatchGuardTechnologiesService(registry);
      const result = await service.scrape({
        siteType: [Site.WATCHGUARD_TECHNOLOGIES],
      } as ScraperInputDto);
      expect(result.jobs[0].id).toBe('watchguard-lever-7');
    });
  });

  describe('resilience', () => {
    it('returns an empty response when no Lever plugin is registered', async () => {
      const service = new WatchGuardTechnologiesService(new PluginRegistry());
      const result = await service.scrape({
        siteType: [Site.WATCHGUARD_TECHNOLOGIES],
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(0);
    });

    it('returns an empty response when no registry is injected', async () => {
      const service = new WatchGuardTechnologiesService();
      const result = await service.scrape({
        siteType: [Site.WATCHGUARD_TECHNOLOGIES],
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
      const service = new WatchGuardTechnologiesService(registryWithLever());
      const result = await service.scrape({
        siteType: [Site.WATCHGUARD_TECHNOLOGIES],
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
    });
  });
});
