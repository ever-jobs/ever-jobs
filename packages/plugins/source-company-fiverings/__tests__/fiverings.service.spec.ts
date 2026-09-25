import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScrapeDiagnostics,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { PluginRegistry, SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { GreenhouseService } from '@ever-jobs/source-ats-greenhouse';

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, post: mockPost, setHeaders: jest.fn() })),
    // The recorded boards are single pages; never sleep between pages in a unit test.
    randomSleep: jest.fn(async () => undefined),
  };
});

import { FiveRingsModule, FiveRingsService } from '../src';

interface Fixture {
  backend: string;
  boards: Array<{ input: Record<string, string>; atsIdPrefix: string }>;
  responses: Record<string, unknown>;
  expected: Array<{ id: string; title: string }>;
}

const FIXTURE: Fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'fiverings-boards.json'), 'utf8'),
);
const COMPANY_NAME = 'Five Rings';
const ID_PREFIX = 'fiverings-';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Serve the recorded responses by URL (query ignored); anything else is a 404. */
function serve(url: string): Promise<{ data: unknown }> {
  const key = String(url).split('?')[0];
  if (Object.prototype.hasOwnProperty.call(FIXTURE.responses, key)) {
    return Promise.resolve({ data: clone(FIXTURE.responses[key]) });
  }
  return notFound(url);
}

function notFound(url: string): Promise<never> {
  const err: any = new Error(`Request failed with status code 404 (${url})`);
  err.response = { status: 404 };
  return Promise.reject(err);
}

function registryWith(scraper: IScraper = new GreenhouseService()): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register({ site: Site.GREENHOUSE, name: 'Greenhouse', category: 'ats', isAts: true }, scraper);
  return registry;
}

function fakeBackend(
  impl: (input: ScraperInputDto) => JobResponseDto,
  captured: ScraperInputDto[] = [],
): IScraper {
  return {
    scrape: async (input) => {
      captured.push(input);
      return impl(input);
    },
  };
}

const boardOf = (input: ScraperInputDto): string | undefined => (input as any).companySlug;
const boardInputOf = (b: Fixture['boards'][number]): string => b.input.companySlug;

describe('FiveRingsService — Greenhouse delegation (Spec 1737)', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockImplementation(serve);
    mockPost.mockImplementation(serve);
  });

  describe('registration', () => {
    it('resolves through FiveRingsModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [FiveRingsModule] }).compile();
      expect(moduleRef.get(FiveRingsService)).toBeInstanceOf(FiveRingsService);
      await moduleRef.close();
    });

    it('exports Site.FIVE_RINGS = "fiverings"', () => {
      expect(Site.FIVE_RINGS).toBe('fiverings');
    });

    it('declares a tagged company plugin with its domains', () => {
      const meta = Reflect.getMetadata(SOURCE_PLUGIN_METADATA, FiveRingsService);
      expect(meta.site).toBe(Site.FIVE_RINGS);
      expect(meta.category).toBe('company');
      expect(meta.isAts).toBeFalsy();
      expect(meta.companyDomains).toEqual(['fiverings.com']);
      expect(meta.description).toContain('segment=quant-trading');
    });
  });

  describe('recorded board (real Greenhouse adapter, mocked HTTP)', () => {
    it('maps every recorded posting and re-stamps the company identity', async () => {
      const service = new FiveRingsService(registryWith());
      const result = await service.scrape({ siteType: [Site.FIVE_RINGS], resultsWanted: 100 } as ScraperInputDto);
      expect(result.diagnostics).toBeUndefined();
      expect(result.jobs.map((j) => j.id)).toEqual(FIXTURE.expected.map((e) => e.id));
      expect(result.jobs.map((j) => j.title)).toEqual(FIXTURE.expected.map((e) => e.title));
      for (const job of result.jobs) {
        expect(job.site).toBe(Site.FIVE_RINGS);
        expect(job.companyName).toBe(COMPANY_NAME);
        expect(job.id?.startsWith(ID_PREFIX)).toBe(true);
        expect(job.jobUrl).toBeTruthy();
      }
    });

    it('only requests the recorded board URLs', async () => {
      const service = new FiveRingsService(registryWith());
      await service.scrape({ siteType: [Site.FIVE_RINGS] } as ScraperInputDto);
      const urls = [...mockGet.mock.calls, ...mockPost.mock.calls].map((c) => String(c[0]).split('?')[0]);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(Object.keys(FIXTURE.responses)).toContain(url);
      }
    });

    it('honours resultsWanted=1', async () => {
      const service = new FiveRingsService(registryWith());
      const result = await service.scrape({ siteType: [Site.FIVE_RINGS], resultsWanted: 1 } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe(FIXTURE.expected[0].id);
    });

    it('resolves with an empty result when the board is gone (HTTP 404)', async () => {
      mockGet.mockImplementation(notFound);
      mockPost.mockImplementation(notFound);
      const service = new FiveRingsService(registryWith());
      const result = await service.scrape({ siteType: [Site.FIVE_RINGS] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('bad_input');
    });
  });

  describe('delegation contract', () => {
    it('forwards the board and the caller input untouched', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new FiveRingsService(
        registryWith(
          fakeBackend(
            () => new JobResponseDto([new JobPostDto({ id: FIXTURE.boards[0].atsIdPrefix + 'x1', title: 'Role', jobUrl: 'u' })]),
            captured,
          ),
        ),
      );
      const result = await service.scrape({
        siteType: [Site.FIVE_RINGS],
        searchTerm: 'software engineer intern',
        location: 'New York',
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(captured).toHaveLength(1);
      expect(boardOf(captured[0])).toBe(boardInputOf(FIXTURE.boards[0]));
      expect(captured[0].searchTerm).toBe('software engineer intern');
      expect(captured[0].location).toBe('New York');
      expect(captured[0].resultsWanted).toBe(1);
      expect(result.jobs[0].id).toBe(ID_PREFIX + 'x1');
      expect(result.jobs[0].site).toBe(Site.FIVE_RINGS);
      expect(result.jobs[0].companyName).toBe(COMPANY_NAME);
    });

    it('never forwards the caller\'s credentials to the board (Spec 1735 §4.5)', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new FiveRingsService(registryWith(fakeBackend(() => new JobResponseDto([]), captured)));
      await service.scrape({
        siteType: [Site.FIVE_RINGS],
        auth: { greenhouse: { apiKey: 'caller-key' } },
      } as unknown as ScraperInputDto);
      expect(captured).toHaveLength(FIXTURE.boards.length);
      for (const forwarded of captured) {
        expect(forwarded.auth).toBeUndefined();
      }
    });

    it('passes an absent resultsWanted through as absent', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new FiveRingsService(registryWith(fakeBackend(() => new JobResponseDto([]), captured)));
      await service.scrape({ siteType: [Site.FIVE_RINGS] } as ScraperInputDto);
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0].resultsWanted).toBeUndefined();
    });

    it('rewrites only the leading ATS id prefix', async () => {
      const prefix = FIXTURE.boards[0].atsIdPrefix;
      const service = new FiveRingsService(
        registryWith(
          fakeBackend(() => new JobResponseDto([new JobPostDto({ id: prefix + prefix + '7', title: 'T', jobUrl: 'u' })])),
        ),
      );
      const result = await service.scrape({ siteType: [Site.FIVE_RINGS], resultsWanted: 1 } as ScraperInputDto);
      expect(result.jobs[0].id).toBe(ID_PREFIX + prefix + '7');
    });

    it('makes no request when resultsWanted is 0', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new FiveRingsService(registryWith(fakeBackend(() => new JobResponseDto([]), captured)));
      const result = await service.scrape({ siteType: [Site.FIVE_RINGS], resultsWanted: 0 } as ScraperInputDto);
      expect(captured).toHaveLength(0);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('resilience', () => {
    it('reports not_registered when no registry is injected', async () => {
      const result = await new FiveRingsService().scrape({ siteType: [Site.FIVE_RINGS] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('not_registered');
      expect(result.diagnostics?.detail).toContain('Greenhouse');
    });

    it('reports not_registered when Greenhouse is missing from the registry', async () => {
      const result = await new FiveRingsService(new PluginRegistry()).scrape({
        siteType: [Site.FIVE_RINGS],
      } as ScraperInputDto);
      expect(result.diagnostics?.reason).toBe('not_registered');
    });

    it('surfaces the backend diagnostic of a failed board', async () => {
      const service = new FiveRingsService(
        registryWith(fakeBackend(() => new JobResponseDto([], new ScrapeDiagnostics('fetch_error', 'HTTP 503')))),
      );
      const result = await service.scrape({ siteType: [Site.FIVE_RINGS] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('fetch_error');
    });

    it('passes a benign empty-board reason through only when nothing was found', async () => {
      const service = new FiveRingsService(
        registryWith(fakeBackend(() => new JobResponseDto([], new ScrapeDiagnostics('empty', 'no postings')))),
      );
      const result = await service.scrape({ siteType: [Site.FIVE_RINGS] } as ScraperInputDto);
      expect(result.diagnostics?.reason).toBe('empty');
    });

    it('classifies a thrown backend error instead of rejecting', async () => {
      const service = new FiveRingsService(
        registryWith({
          scrape: async () => {
            throw new Error('socket hang up');
          },
        }),
      );
      const result = await service.scrape({ siteType: [Site.FIVE_RINGS] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics?.reason).not.toBe('ok');
    });
  });

  describe('credential isolation (Spec 1735 §4.5)', () => {
    const saved = {
      key: process.env.GREENHOUSE_API_KEY,
      board: process.env.GREENHOUSE_HARVEST_BOARD,
    };

    afterEach(() => {
      if (saved.key === undefined) delete process.env.GREENHOUSE_API_KEY;
      else process.env.GREENHOUSE_API_KEY = saved.key;
      if (saved.board === undefined) delete process.env.GREENHOUSE_HARVEST_BOARD;
      else process.env.GREENHOUSE_HARVEST_BOARD = saved.board;
    });

    it('requests only its own public board with GREENHOUSE_API_KEY set', async () => {
      process.env.GREENHOUSE_API_KEY = 'operator-harvest-key';
      delete process.env.GREENHOUSE_HARVEST_BOARD;
      const service = new FiveRingsService(registryWith());
      const result = await service.scrape({
        siteType: [Site.FIVE_RINGS],
        resultsWanted: 100,
        auth: { greenhouse: { apiKey: 'caller-harvest-key' } },
      } as unknown as ScraperInputDto);

      const urls = [...mockGet.mock.calls, ...mockPost.mock.calls].map((c) => String(c[0]).split('?')[0]);
      expect(urls).toEqual(Object.keys(FIXTURE.responses));
      expect(result.jobs.map((j) => j.id)).toEqual(FIXTURE.expected.map((e) => e.id));
    });
  });
});
