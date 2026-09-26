import 'reflect-metadata';

const mockGet = jest.fn();
const mockCreateHttpClient = jest.fn();

jest.mock('@ever-jobs/common', () => ({
  ...(jest.requireActual('@ever-jobs/common') as object),
  createHttpClient: (options: unknown) => {
    mockCreateHttpClient(options);
    return { get: mockGet };
  },
}));

import { Logger } from '@nestjs/common';
import {
  CompensationInterval,
  DatePostedBasis,
  DatePostedPrecision,
  DescriptionFormat,
  JobPostDto,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { RemoteOkService } from '../src/remoteok.service';
import { REMOTEOK_API_URL, REMOTEOK_LEGACY_ENV } from '../src/remoteok.constants';
import { MOJIBAKE, MOJIBAKE_PATTERN, NOW_MS, feed, job, ok, resetJobIds } from './fixtures/remoteok-feed.fixture';

/**
 * Spec 1707 - RemoteOK tag-feed recall, text repair, hoursOld, offset,
 * direct-URL semantics and failure diagnostics, against a mocked client.
 */

function input(fields: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({ resultsWanted: 100, ...fields });
}

function scrape(fields: Partial<ScraperInputDto> = {}) {
  return new RemoteOkService().scrape(input(fields));
}

/** Every string reachable from a job (location included). */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

function titles(jobs: JobPostDto[]): string[] {
  return jobs.map((j) => j.title);
}

describe('RemoteOkService (Spec 1707)', () => {
  const savedLegacy = process.env[REMOTEOK_LEGACY_ENV];

  beforeAll(() => {
    // The service logs every scrape; keep the test output readable.
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW_MS, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    mockGet.mockReset();
    mockCreateHttpClient.mockReset();
    resetJobIds();
    delete process.env[REMOTEOK_LEGACY_ENV];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    jest.restoreAllMocks();
    if (savedLegacy === undefined) delete process.env[REMOTEOK_LEGACY_ENV];
    else process.env[REMOTEOK_LEGACY_ENV] = savedLegacy;
  });

  describe('feed plan', () => {
    it('fetches only the global feed without a term and skips the metadata row', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ id: '11' }), job({ id: '12' }))));

      const result = await scrape();

      expect(mockGet).toHaveBeenCalledTimes(1);
      const [url, config] = mockGet.mock.calls[0];
      expect(url).toBe(REMOTEOK_API_URL);
      expect(config.params).toBeUndefined();
      expect(result.diagnostics).toBeUndefined();
      expect(result.jobs.map((j) => j.id)).toEqual(['remoteok-11', 'remoteok-12']);
      for (const j of result.jobs) {
        expect(j.site).toBe(Site.REMOTEOK);
        expect(j.isRemote).toBe(true);
        expect(new URL(j.jobUrl).host).toBe('remoteok.com');
      }
    });

    it('asks the tag feed for the seed token and stops there when it has jobs', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ position: 'Python Engineer' }))));

      const result = await scrape({ searchTerm: 'python' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockGet.mock.calls[0][1].params).toEqual({ tag: 'python' });
      expect(titles(result.jobs)).toEqual(['Python Engineer']);
      expect(result.diagnostics).toBeUndefined();
    });

    it('falls back to the global feed when the tag feed has no jobs, and still matches locally', async () => {
      mockGet
        .mockResolvedValueOnce(ok(feed()))
        .mockResolvedValueOnce(ok(feed(job({ position: 'Rust Engineer' }), job({ position: 'Python Engineer' }))));

      const result = await scrape({ searchTerm: 'python' });

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockGet.mock.calls[1][1].params).toBeUndefined();
      expect(titles(result.jobs)).toEqual(['Python Engineer']);
      expect(result.diagnostics).toBeUndefined();
    });

    it('never asks for a tag when every token is generic or not slug-safe', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ position: 'Senior C++ Engineer' }))));

      const result = await scrape({ searchTerm: 'senior c++ engineer' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockGet.mock.calls[0][1].params).toBeUndefined();
      expect(titles(result.jobs)).toEqual(['Senior C++ Engineer']);
    });
  });

  describe('failure diagnostics', () => {
    it('reports partial when the tag feed fails and the global feed serves matches', async () => {
      mockGet
        .mockRejectedValueOnce(new Error('Request failed with status code 500'))
        .mockResolvedValueOnce(ok(feed(job({ position: 'Python Engineer' }))));

      const result = await scrape({ searchTerm: 'python' });

      expect(titles(result.jobs)).toEqual(['Python Engineer']);
      expect(result.diagnostics?.reason).toBe('partial');
      expect(result.diagnostics?.detail).toContain('python');
      expect(result.diagnostics?.detail).toContain('500');
    });

    it('reports the tag failure, not a bare empty, when the global feed has no match', async () => {
      mockGet
        .mockRejectedValueOnce(new Error('Request failed with status code 500'))
        .mockResolvedValueOnce(ok(feed(job({ position: 'Rust Engineer' }))));

      const result = await scrape({ searchTerm: 'python' });

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('fetch_error');
    });

    it('reports blocked for a 403 on the global feed', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status code 403'));

      const result = await scrape();

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('blocked');
    });

    it('reports blocked for a challenge page served instead of JSON', async () => {
      mockGet.mockResolvedValueOnce(ok('<html><title>Just a moment...</title></html>'));

      const result = await scrape();

      expect(result.diagnostics?.reason).toBe('blocked');
    });

    it('reports a non-array payload instead of an empty board', async () => {
      mockGet.mockResolvedValueOnce(ok({ error: 'maintenance' }));

      const result = await scrape();

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('unknown');
      expect(result.diagnostics?.detail).toContain('non-array');
    });

    it('reports a timeout on the global feed', async () => {
      mockGet.mockRejectedValueOnce(new Error('timeout of 60000ms exceeded'));

      const result = await scrape();

      expect(result.diagnostics?.reason).toBe('timeout');
    });

    it('does not ask again after the tag feed is blocked', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status code 403'));

      const result = await scrape({ searchTerm: 'python' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('blocked');
    });

    it('does not ask again after the tag feed is rate limited', async () => {
      mockGet.mockRejectedValueOnce(new Error('Request failed with status code 429'));

      const result = await scrape({ searchTerm: 'python' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(result.diagnostics?.reason).toBe('fetch_error');
    });

    it('reports the global failure when both feeds fail', async () => {
      mockGet
        .mockRejectedValueOnce(new Error('Request failed with status code 502'))
        .mockRejectedValueOnce(new Error('Request failed with status code 403'));

      const result = await scrape({ searchTerm: 'python' });

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(result.diagnostics?.reason).toBe('blocked');
    });
  });

  describe('matching and ranking', () => {
    it('ANDs the tokens and ranks a title match above a newer description match', async () => {
      mockGet.mockResolvedValueOnce(
        ok(
          feed(
            job({ position: 'Python Developer', description: '<p>Plain role.</p>', ageHours: 1 }),
            job({ position: 'Python Developer', description: '<p>A senior role.</p>', ageHours: 2 }),
            job({ position: 'Senior Python Engineer', ageHours: 3 }),
          ),
        ),
      );

      const result = await scrape({ searchTerm: 'senior python' });

      expect(mockGet.mock.calls[0][1].params).toEqual({ tag: 'python' });
      expect(result.jobs.map((j) => [j.title, j.description])).toEqual([
        ['Senior Python Engineer', expect.any(String)],
        ['Python Developer', expect.stringContaining('senior role')],
      ]);
    });

    it('matches the company name', async () => {
      mockGet.mockResolvedValueOnce(
        ok(feed(job({ company: 'Globex Labs', position: 'Designer' }), job({ company: 'Initech', position: 'Designer' }))),
      );

      const result = await scrape({ searchTerm: 'globex' });

      expect(result.jobs.map((j) => j.companyName)).toEqual(['Globex Labs']);
    });

    it('uses whole words: java does not match JavaScript', async () => {
      mockGet
        .mockResolvedValueOnce(ok(feed()))
        .mockResolvedValueOnce(ok(feed(job({ position: 'JavaScript Developer' }), job({ position: 'Java Developer' }))));

      const result = await scrape({ searchTerm: 'java' });

      expect(titles(result.jobs)).toEqual(['Java Developer']);
    });

    it('ranks tag-only evidence last', async () => {
      mockGet.mockResolvedValueOnce(
        ok(
          feed(
            job({ position: 'Support Agent', tags: ['python'], ageHours: 1 }),
            job({ position: 'Python Engineer', ageHours: 5 }),
          ),
        ),
      );

      const result = await scrape({ searchTerm: 'python' });

      expect(titles(result.jobs)).toEqual(['Python Engineer', 'Support Agent']);
    });
  });

  describe('hoursOld', () => {
    it('drops rows older than the window and keeps rows with no usable date', async () => {
      const dateOnly = job({ position: 'Date Only', ageHours: 3 });
      delete dateOnly.epoch;
      const undated = job({ position: 'Undated' });
      delete undated.epoch;
      delete undated.date;
      const staleByDate = job({ position: 'Stale By Date', ageHours: 40 });
      delete staleByDate.epoch;

      mockGet.mockResolvedValueOnce(
        ok(feed(job({ position: 'Fresh', ageHours: 2 }), job({ position: 'Stale', ageHours: 30 }), dateOnly, undated, staleByDate)),
      );

      const result = await scrape({ hoursOld: 24 });

      expect(titles(result.jobs)).toEqual(['Fresh', 'Date Only', 'Undated']);
    });

    it('ignores a non-positive hoursOld', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ ageHours: 900 }))));

      const result = await scrape({ hoursOld: 0 });

      expect(result.jobs).toHaveLength(1);
    });
  });

  describe('offset and limit', () => {
    it('applies offset then resultsWanted after ranking', async () => {
      mockGet.mockResolvedValueOnce(
        ok(feed(...[1, 2, 3, 4, 5].map((n) => job({ position: `Python Engineer ${n}` })))),
      );

      const result = await scrape({ searchTerm: 'python', offset: 2, resultsWanted: 2 });

      expect(titles(result.jobs)).toEqual(['Python Engineer 3', 'Python Engineer 4']);
    });

    it('returns an empty page without diagnostics past the end', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job())));

      const result = await scrape({ offset: 10 });

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics).toBeUndefined();
    });

    it('defaults to 100 when resultsWanted is unset', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(...Array.from({ length: 120 }, () => job()))));

      const result = await new RemoteOkService().scrape(
        Object.assign(new ScraperInputDto(), { resultsWanted: undefined }),
      );

      expect(result.jobs).toHaveLength(100);
    });
  });

  describe('text repair', () => {
    it('repairs title, company, location, tags and description end to end', async () => {
      mockGet.mockResolvedValueOnce(
        ok(
          feed(
            job({
              position: MOJIBAKE.emDashTitle,
              company: MOJIBAKE.company,
              location: MOJIBAKE.arabicLocation,
              description: MOJIBAKE.description,
              tags: [MOJIBAKE.tag, 'ops'],
            }),
            job({ position: MOJIBAKE.truncatedTitle }),
          ),
        ),
      );

      const result = await scrape({ descriptionFormat: DescriptionFormat.HTML });

      const [first, second] = result.jobs;
      expect(first.title).toBe(MOJIBAKE.emDashTitleFixed);
      expect(first.companyName).toBe(MOJIBAKE.companyFixed);
      expect(first.location?.city).toBe(MOJIBAKE.arabicCity);
      expect(first.skills).toEqual([MOJIBAKE.tagFixed, 'ops']);
      expect(first.description).toContain('Widget\u{2122} platform \u{2014} grabaci\xF3n \u{1F605}');
      expect(second.title).toBe(MOJIBAKE.truncatedTitleFixed);
      for (const text of strings(result.jobs)) {
        expect(text).not.toMatch(MOJIBAKE_PATTERN);
      }
    });

    it('matches on repaired, folded text', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ company: MOJIBAKE.company, position: 'Barista' }))));

      const result = await scrape({ searchTerm: 'cafe' });

      expect(result.jobs.map((j) => j.companyName)).toEqual([MOJIBAKE.companyFixed]);
    });

    it.each([DescriptionFormat.PLAIN, DescriptionFormat.MARKDOWN])('outputs repaired %s descriptions', async (format) => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ description: MOJIBAKE.description }))));

      const result = await scrape({ descriptionFormat: format });

      expect(result.jobs[0].description).toContain(MOJIBAKE.descriptionFixedText);
      expect(result.jobs[0].description).not.toMatch(MOJIBAKE_PATTERN);
    });

    it('collapses whitespace runs in title and company', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ position: 'Python\n Developer', company: ' Acme\n  Robotics ' }))));

      const [j] = (await scrape()).jobs;

      expect(j.title).toBe('Python Developer');
      expect(j.companyName).toBe('Acme Robotics');
    });

    it('decodes HTML entities in plain-text fields only', async () => {
      mockGet.mockResolvedValueOnce(
        ok(feed(job({ position: 'Sales &amp; Ops Lead', company: 'R&amp;S Group', description: '<p>A &amp; B</p>' }))),
      );

      const result = await scrape({ descriptionFormat: DescriptionFormat.HTML });

      expect(result.jobs[0].title).toBe('Sales & Ops Lead');
      expect(result.jobs[0].companyName).toBe('R&S Group');
      expect(result.jobs[0].description).toBe('<p>A &amp; B</p>');
    });
  });

  describe('locations', () => {
    it('collapses repeated parts before parsing', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ location: 'Austin, Austin, Texas, United States' }))));

      const result = await scrape();

      expect(result.jobs[0].location).toMatchObject({ city: 'Austin', state: 'TX' });
    });

    it('maps a bare non-English remote word to Remote', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ location: 'Remoto' }))));

      const result = await scrape();

      expect(result.jobs[0].location?.city).not.toBe('Remoto');
      expect(result.jobs[0].isRemote).toBe(true);
    });
  });

  describe('URLs', () => {
    it('keeps a board apply link out of jobUrlDirect', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job())));

      const [j] = (await scrape()).jobs;

      expect(j.jobUrl).toMatch(/^https:\/\/remoteok\.com\/remote-jobs\//);
      expect(j.applyUrl).toBe(j.jobUrl);
      expect(j.jobUrlDirect).toBeNull();
    });

    it('treats an off-board apply link as direct', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ apply_url: 'https://jobs.example.com/apply/1' }))));

      const [j] = (await scrape()).jobs;

      expect(j.applyUrl).toBe('https://jobs.example.com/apply/1');
      expect(j.jobUrlDirect).toBe('https://jobs.example.com/apply/1');
    });

    it('builds the job page from the slug when url is missing', async () => {
      const row = job({ slug: 'remote-widget-maker-acme-77', id: '77' });
      delete row.url;
      delete row.apply_url;
      mockGet.mockResolvedValueOnce(ok(feed(row)));

      const [j] = (await scrape()).jobs;

      expect(j.jobUrl).toBe('https://remoteok.com/remote-jobs/remote-widget-maker-acme-77');
      expect(j.applyUrl).toBe(j.jobUrl);
    });

    it('builds the job page from the id when url is the bare index and slug is empty', async () => {
      mockGet.mockResolvedValueOnce(
        ok(
          feed(
            job({
              id: '1136379',
              slug: '',
              url: 'https://remoteOK.com/remote-jobs/',
              apply_url: 'https://remoteOK.com/remote-jobs/',
            }),
          ),
        ),
      );

      const [j] = (await scrape()).jobs;

      expect(j.jobUrl).toBe('https://remoteok.com/remote-jobs/1136379');
      expect(j.applyUrl).toBe(j.jobUrl);
      expect(j.jobUrlDirect).toBeNull();
    });

    it('skips a row with no usable job page', async () => {
      const row = job({ id: 'abc', slug: '' });
      delete row.url;
      mockGet.mockResolvedValueOnce(ok(feed(row, job({ id: '5' }))));

      const result = await scrape();

      expect(result.jobs.map((j) => j.id)).toEqual(['remoteok-5']);
    });

    it('falls back to the second logo field', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ logo: 'https://cdn.example.com/acme.png' }))));

      const [j] = (await scrape()).jobs;

      expect(j.companyLogo).toBe('https://cdn.example.com/acme.png');
    });

    it('resolves a relative logo against the board and refuses other schemes', async () => {
      mockGet.mockResolvedValueOnce(
        ok(feed(job({ company_logo: '/assets/acme.png' }), job({ company_logo: 'javascript:alert(1)' }))),
      );

      const [relative, script] = (await scrape()).jobs;

      expect(relative.companyLogo).toBe('https://remoteok.com/assets/acme.png');
      expect(script.companyLogo).toBeNull();
    });
  });

  describe('salary', () => {
    it('emits a plausible pair as yearly USD', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ salary_min: 60000, salary_max: 80000 }))));

      const [j] = (await scrape()).jobs;

      expect(j.compensation).toMatchObject({
        interval: CompensationInterval.YEARLY,
        minAmount: 60000,
        maxAmount: 80000,
        currency: 'USD',
      });
    });

    it.each([
      [30, 36],
      [10000, 750000],
    ])('drops the implausible pair %p-%p', async (min, max) => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ salary_min: min, salary_max: max }))));

      const [j] = (await scrape()).jobs;

      expect(j.compensation).toBeNull();
    });
  });

  describe('posted time', () => {
    it('keeps the source day and adds the exact instant', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job({ date: '2026-09-23T14:00:02+00:00', epoch: 1790172002 }))));

      const [j] = (await scrape()).jobs;

      expect(j.datePosted).toBe('2026-09-23');
      expect(j.datePostedAt).toBe('2026-09-23T14:00:02.000Z');
      expect(j.datePostedPrecision).toBe(DatePostedPrecision.EXACT);
      expect(j.datePostedBasis).toBe(DatePostedBasis.TIMESTAMP);
    });

    it('falls back to epoch when date is missing', async () => {
      const row = job({ epoch: 1790172002 });
      delete row.date;
      mockGet.mockResolvedValueOnce(ok(feed(row)));

      const [j] = (await scrape()).jobs;

      expect(j.datePosted).toBe('2026-09-23');
      expect(j.datePostedAt).toBe('2026-09-23T14:00:02.000Z');
    });

    it('is null when neither is usable', async () => {
      const row = job();
      delete row.date;
      delete row.epoch;
      mockGet.mockResolvedValueOnce(ok(feed(row)));

      const [j] = (await scrape()).jobs;

      expect(j.datePosted).toBeNull();
      expect(j.datePostedAt).toBeUndefined();
    });
  });

  describe('client options and headers', () => {
    it('identifies itself by default', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job())));

      await scrape();

      expect(mockGet.mock.calls[0][1].headers['User-Agent']).toBe(
        'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)',
      );
    });

    it('EVER_JOBS_REMOTEOK_LEGACY=ua restores the pre-1707 browser User-Agent; a caller UA still wins', async () => {
      process.env[REMOTEOK_LEGACY_ENV] = 'ua';
      mockGet.mockResolvedValue(ok(feed(job())));

      await scrape();
      expect(mockGet.mock.calls[0][1].headers['User-Agent']).toMatch(/Chrome\/129/);

      await scrape({ userAgent: 'EverJobsTest/1.0' });
      expect(mockGet.mock.calls[1][1].headers['User-Agent']).toBe('EverJobsTest/1.0');
    });
    it('lets the caller User-Agent win over the constant', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job())));

      await scrape({ userAgent: 'EverJobsTest/1.0 (+https://example.com/bot)' });

      expect(mockGet.mock.calls[0][1].headers['User-Agent']).toBe('EverJobsTest/1.0 (+https://example.com/bot)');
      expect(mockGet.mock.calls[0][1].headers.Accept).toBe('application/json');
      expect(mockCreateHttpClient.mock.calls[0][0]).toMatchObject({ userAgent: 'EverJobsTest/1.0 (+https://example.com/bot)' });
    });

    it('passes the timeout through even when proxies are set', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job())));

      await scrape({ proxies: ['http://proxy.example:8080'], requestTimeout: 17 });

      expect(mockCreateHttpClient.mock.calls[0][0]).toMatchObject({
        proxies: ['http://proxy.example:8080'],
        requestTimeout: 17,
        timeout: 17,
      });
    });

    it('never spaces requests closer than the crawl delay', async () => {
      mockGet.mockResolvedValue(ok(feed(job())));

      await scrape();
      await scrape({ rateDelayMin: 0, rateDelayMax: 0 });
      await scrape({ rateDelayMin: 3 });

      const options = mockCreateHttpClient.mock.calls.map((c) => c[0]);
      expect(options[0]).toMatchObject({ rateDelayMin: 1, rateDelayMax: 1.5 });
      expect(options[1]).toMatchObject({ rateDelayMin: 1, rateDelayMax: 1 });
      expect(options[2]).toMatchObject({ rateDelayMin: 3, rateDelayMax: 3 });
    });

    it('pins redirects to the board hosts', async () => {
      mockGet.mockResolvedValueOnce(ok(feed(job())));

      await scrape();

      expect(mockCreateHttpClient.mock.calls[0][0].allowedRedirectHosts).toEqual(['remoteok.com', 'remoteok.io']);
    });
  });

  describe('row shape', () => {
    it('skips rows without id or position and a metadata row anywhere', async () => {
      mockGet.mockResolvedValueOnce(
        ok([
          job({ id: '1' }),
          { last_updated: 1, legal: 'terms' },
          { position: 'No Id' },
          { id: '3' },
          job({ id: '4', position: '   ' }),
          job({ id: '5' }),
        ]),
      );

      const result = await scrape();

      expect(result.jobs.map((j) => j.id)).toEqual(['remoteok-1', 'remoteok-5']);
    });

    it('keeps mapping after one row throws', async () => {
      const bad = job({ id: '1' });
      Object.defineProperty(bad, 'salary_min', {
        get() {
          throw new Error('boom');
        },
        enumerable: true,
      });
      mockGet.mockResolvedValueOnce(ok(feed(bad, job({ id: '2' }))));

      const result = await scrape();

      expect(result.jobs.map((j) => j.id)).toEqual(['remoteok-2']);
    });
  });

  describe(`${REMOTEOK_LEGACY_ENV}`, () => {
    it('search: global feed only, whole-phrase substring on title and tags', async () => {
      process.env[REMOTEOK_LEGACY_ENV] = 'search';
      mockGet.mockResolvedValueOnce(
        ok(feed(job({ position: 'JavaScript Developer' }), job({ position: 'Designer', company: 'Java Co' }))),
      );

      const result = await scrape({ searchTerm: 'java' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockGet.mock.calls[0][1].params).toBeUndefined();
      expect(titles(result.jobs)).toEqual(['JavaScript Developer']);
    });

    it('text: fields exactly as the feed sent them', async () => {
      process.env[REMOTEOK_LEGACY_ENV] = 'text';
      mockGet.mockResolvedValueOnce(ok(feed(job({ position: MOJIBAKE.truncatedTitle, company: 'R&amp;S' }))));

      const [j] = (await scrape()).jobs;

      expect(j.title).toBe(MOJIBAKE.truncatedTitle);
      expect(j.companyName).toBe('R&amp;S');
    });

    it('urls: url, apply_url and company_logo verbatim', async () => {
      process.env[REMOTEOK_LEGACY_ENV] = 'urls';
      mockGet.mockResolvedValueOnce(
        ok(feed(job({ id: '9', logo: 'https://cdn.example.com/second.png' }), job({ id: '10', company_logo: 'acme.png' }))),
      );

      const [first, second] = (await scrape()).jobs;

      expect(first.jobUrl).toMatch(/^https:\/\/remoteOK\.com\/remote-jobs\//);
      expect(first.jobUrlDirect).toBe(first.jobUrl);
      expect(first.applyUrl).toBe(first.jobUrl);
      expect(first.companyLogo).toBeNull();
      expect(second.companyLogo).toBe('acme.png');
    });

    it('salary: any both-positive pair', async () => {
      process.env[REMOTEOK_LEGACY_ENV] = 'salary';
      mockGet.mockResolvedValueOnce(ok(feed(job({ salary_min: 30, salary_max: 36 }))));

      const [j] = (await scrape()).jobs;

      expect(j.compensation).toMatchObject({ minAmount: 30, maxAmount: 36 });
    });

    it('location: the label reaches the parser untidied', async () => {
      process.env[REMOTEOK_LEGACY_ENV] = 'location';
      mockGet.mockResolvedValueOnce(ok(feed(job({ location: 'Remoto' }))));

      const [j] = (await scrape()).jobs;

      expect(j.location?.city).toBe('Remoto');
    });

    it('true restores every part at once', async () => {
      process.env[REMOTEOK_LEGACY_ENV] = 'true';
      mockGet.mockResolvedValueOnce(ok(feed(job({ position: MOJIBAKE.emDashTitle, salary_min: 30, salary_max: 36 }))));

      const [j] = (await scrape({ searchTerm: 'lead' })).jobs;

      expect(mockGet.mock.calls[0][1].params).toBeUndefined();
      expect(j.title).toBe(MOJIBAKE.emDashTitle);
      expect(j.compensation).toMatchObject({ minAmount: 30 });
      expect(j.jobUrlDirect).toBe(j.jobUrl);
    });
  });
});
