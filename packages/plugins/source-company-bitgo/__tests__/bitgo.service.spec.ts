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

import { BitgoModule, BitgoService } from '../src';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const JOBS_PAGE_RAW = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'bitgo-jobs.json'), 'utf8'),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Spec 154 / T04 — `BitgoService` unit tests.
 *
 * Coverage (>= 8 mandated by spec § 8 / FR-10):
 *   1. NestJS DI resolves `BitgoService` through `BitgoModule`.
 *   2. `Site.BITGO === 'bitgo'` literal pin.
 *   3. Happy path — variant-2 URL pass-through; **D-09
 *      TWO-cap PascalCase case-asymmetric wire pin**
 *      (`'BitGo'` 5 bytes; caps at 0/3 — NEW caps-at-0/3
 *      sub-pattern); **D-10 leading-pad title-trim lock**;
 *      D-11 clean dept pass-through lock.
 *   4..8. resultsWanted, searchTerm filters, error handling,
 *      empty payload.
 */
describe('BitgoService — Spec 154 / T04', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('registration scaffolding', () => {
    it('resolves through BitgoModule via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [BitgoModule],
      }).compile();
      const service = moduleRef.get(BitgoService);
      expect(service).toBeInstanceOf(BitgoService);
      await moduleRef.close();
    });

    it('exports the Site.BITGO = "bitgo" enum value', () => {
      expect(Site.BITGO).toBe('bitgo');
    });
  });

  describe('happy path — 2 listings mapped to JobPostDto', () => {
    it('maps both fixture listings to JobPostDto with expected fields', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BitgoService();
      const result = await service.scrape({
        siteType: [Site.BITGO],
        resultsWanted: 100,
      } as ScraperInputDto);
      const dto = result as JobResponseDto;
      expect(dto.jobs).toHaveLength(2);

      const ase = dto.jobs.find((j) => j.id === 'bitgo-7821447002');
      expect(ase).toBeDefined();
      expect(ase?.site).toBe(Site.BITGO);
      // D-09 TWO-cap PascalCase case-asymmetric lock — caps
      // at byte indices 0 (B) and 3 (G) — NEW caps-at-0/3
      // sub-pattern.
      expect(ase?.companyName).toBe('BitGo');
      expect(ase?.companyName?.toLowerCase()).toBe('bitgo');
      const cn = ase?.companyName ?? '';
      expect(cn[0]).toBe('B');
      expect(cn[3]).toBe('G');
      expect(ase?.title).toBe('Application Security Engineer');
      // D-04 lock — variant 2 (canonical Greenhouse host).
      expect(ase?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/bitgo/jobs/7821447002',
      );
      // D-11 clean dept pass-through.
      expect(ase?.department).toBe('Security');
      expect(ase?.location?.city).toBe('Palo Alto, CA');
      expect(ase?.isRemote).toBe(false);
      // D-08 regression guard.
      expect(ase?.description).not.toContain('&lt;');
      expect(ase?.description).not.toContain('<p>');
      expect(ase?.description).toContain('BitGo');

      const sd = dto.jobs.find((j) => j.id === 'bitgo-8121419002');
      expect(sd).toBeDefined();
      // D-10 lock — wire title carries LEADING-pad
      // (6th cohort observation); emitted title trimmed.
      expect(JOBS_PAGE_RAW.jobs[1].title).toBe(' Senior Director Risk Management');
      expect(sd?.title).toBe('Senior Director Risk Management');
      expect(sd?.title).not.toMatch(/^\s/);
      expect(sd?.companyName).toBe('BitGo');
      expect(sd?.location?.city).toBe('Remote, US');
      expect(sd?.isRemote).toBe(true);
      expect(sd?.department).toBe('Risk');
      expect(sd?.jobUrl).toBe(
        'https://job-boards.greenhouse.io/bitgo/jobs/8121419002',
      );

      const calledUrls = mockGet.mock.calls.map((c) => c[0] as string);
      expect(calledUrls[0]).toBe(
        'https://api.greenhouse.io/v1/boards/bitgo/jobs?content=true',
      );
    });
  });

  describe('resultsWanted cap', () => {
    it('honours resultsWanted=1 against a 2-item page', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BitgoService();
      const result = await service.scrape({
        siteType: [Site.BITGO],
        resultsWanted: 1,
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('searchTerm filter', () => {
    it('filters by case-insensitive substring of trimmed title', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BitgoService();
      const result = await service.scrape({
        siteType: [Site.BITGO],
        searchTerm: 'DIRECTOR',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bitgo-8121419002');
    });

    it('filters by case-insensitive substring of department name', async () => {
      mockGet.mockResolvedValueOnce({ data: clone(JOBS_PAGE_RAW) });

      const service = new BitgoService();
      const result = await service.scrape({
        siteType: [Site.BITGO],
        searchTerm: 'security',
      } as ScraperInputDto);

      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe('bitgo-7821447002');
      expect(result.jobs[0].department).toBe('Security');
    });
  });

  describe('error handling', () => {
    it('catches an HTTP 500 → empty JobResponseDto, never throws', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status 500'));

      const service = new BitgoService();
      const result = await service.scrape({
        siteType: [Site.BITGO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
      // jobs alone stays empty whatever the plugin reports, so this is the
      // assertion that pins the diagnostics contract. The mock throws a 500.
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('returns empty when the response payload has no jobs', async () => {
      mockGet.mockResolvedValueOnce({ data: { jobs: [] } });

      const service = new BitgoService();
      const result = await service.scrape({
        siteType: [Site.BITGO],
      } as ScraperInputDto);

      expect(result.jobs).toEqual([]);
    });
  });
});
