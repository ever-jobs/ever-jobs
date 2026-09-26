import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  CompensationInterval,
  DatePostedBasis,
  DatePostedPrecision,
  DescriptionFormat,
  JobPostDto,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockPost = jest.fn();
const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
const mockCreateHttpClient = jest.fn((_options?: unknown) => ({
  post: mockPost,
  get: mockGet,
  setHeaders: mockSetHeaders,
}));
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: (options?: unknown) => mockCreateHttpClient(options),
  };
});

import { WelcomeToTheJungleModule } from '../src/wttj.module';
import { WelcomeToTheJungleService } from '../src/wttj.service';
import {
  WTTJ_ALGOLIA_API_KEY,
  WTTJ_ALGOLIA_APP_ID,
  WTTJ_BOARD_ATTRIBUTES,
  WTTJ_BROWSER_USER_AGENT,
  WTTJ_CREDENTIAL_HOSTS,
  WTTJ_ENV,
  WTTJ_HONEST_USER_AGENT,
} from '../src/wttj.constants';
import { resetWttjCredentialCache } from '../src/wttj.credentials';
import { WttjAlgoliaResponse, WttjJobHit } from '../src/wttj.types';

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const HITS_RAW = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'wttj-hits.json'), 'utf8')) as WttjAlgoliaResponse;
const DETAIL_HTML = fs.readFileSync(path.join(FIXTURE_DIR, 'wttj-detail-runtime-config.html'), 'utf8');
const FRESH_KEY = '0123456789abcdef0123456789abcdef';
const EN_INDEX_URL = 'https://csekhvms53-dsn.algolia.net/1/indexes/wttj_jobs_production_en/query';
const FR_INDEX_URL = 'https://csekhvms53-dsn.algolia.net/1/indexes/wttj_jobs_production_fr/query';
const POSTING_TIME_ENV = 'EVER_JOBS_POSTED_TIME_DETAIL';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fixtureResponse(): { data: WttjAlgoliaResponse } {
  return { data: clone(HITS_RAW) };
}

/** A minimal board hit at result position `n`. */
function boardHit(n: number, extra: Partial<WttjJobHit> = {}): WttjJobHit {
  const ref = `ref-${String(n).padStart(4, '0')}`;
  return {
    objectID: ref,
    reference: ref,
    name: `Role ${n}`,
    slug: `role-${n}_city_ACME_${n}`,
    language: 'en',
    contract_type: 'full_time',
    remote: 'fulltime',
    offices: [{ city: 'Paris', state: 'Ile-de-France', country: 'France', country_code: 'FR' }],
    organization: { name: 'Acme Robotics', slug: 'acme-robotics' },
    ...extra,
  };
}

/** A board page holding positions [from, from + count). */
function boardPage(
  from: number,
  count: number,
  meta: { nbHits?: number; nbPages?: number; page?: number; hitsPerPage?: number } = {},
): { data: WttjAlgoliaResponse } {
  return {
    data: {
      hits: Array.from({ length: count }, (_, i) => boardHit(from + i)),
      nbHits: meta.nbHits ?? 5000,
      nbPages: meta.nbPages,
      page: meta.page,
      hitsPerPage: meta.hitsPerPage,
    },
  };
}

function httpError(status: number, message?: string): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: message ? { message, status } : {} },
  });
}

function companyInput(extra: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({
    siteType: [Site.WTTJ],
    companySlug: 'acme-robotics',
    resultsWanted: 100,
    descriptionFormat: DescriptionFormat.HTML,
    ...extra,
  });
}

function byRef(jobs: JobPostDto[], prefix: string): JobPostDto {
  const job = jobs.find((j) => j.atsId?.startsWith(prefix));
  if (!job) throw new Error(`no job ${prefix}`);
  return job;
}

type PostCall = [string, Record<string, unknown>, { headers?: Record<string, string> } | undefined];

function postCalls(): PostCall[] {
  return mockPost.mock.calls as PostCall[];
}

const ENV_KEYS = [...Object.values(WTTJ_ENV), POSTING_TIME_ENV];

/**
 * Spec 1705 — `WelcomeToTheJungleService`: hit mapping (B), board-wide search (A) and the
 * credential self-heal (C), against synthetic fixtures and a mocked HTTP client.
 */
describe('WelcomeToTheJungleService (Spec 1705)', () => {
  let service: WelcomeToTheJungleService;

  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockCreateHttpClient.mockClear();
    resetWttjCredentialCache();
    for (const key of ENV_KEYS) delete process.env[key];
    service = new WelcomeToTheJungleService();
  });

  afterAll(() => {
    resetWttjCredentialCache();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  describe('registration', () => {
    it('resolves through WelcomeToTheJungleModule and exposes scrapeBoard', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [WelcomeToTheJungleModule] }).compile();
      const resolved = moduleRef.get(WelcomeToTheJungleService);
      expect(resolved).toBeInstanceOf(WelcomeToTheJungleService);
      expect(typeof resolved.scrapeBoard).toBe('function');
      expect(Site.WTTJ).toBe('wttj');
      await moduleRef.close();
    });
  });

  describe('company mode: request (unchanged)', () => {
    it('sends the same body to the _en index with the built-in credentials', async () => {
      mockPost.mockResolvedValueOnce(fixtureResponse());
      const res = await service.scrape(companyInput());
      expect(res.jobs).toHaveLength(8);
      expect(res.diagnostics).toBeUndefined();
      expect(mockPost).toHaveBeenCalledTimes(1);
      const [url, body, config] = postCalls()[0];
      expect(url).toBe(EN_INDEX_URL);
      expect(body).toEqual({
        query: '',
        hitsPerPage: 100,
        page: 0,
        facetFilters: [['organization.slug:acme-robotics']],
      });
      expect(config?.headers).toEqual({
        'x-algolia-application-id': WTTJ_ALGOLIA_APP_ID,
        'x-algolia-api-key': WTTJ_ALGOLIA_API_KEY,
      });
    });

    it('falls back to the _fr index when _en has no roles, or answers 404', async () => {
      mockPost.mockResolvedValueOnce({ data: { hits: [], nbHits: 0 } }).mockResolvedValueOnce(fixtureResponse());
      expect((await service.scrape(companyInput())).jobs).toHaveLength(8);
      expect(postCalls().map(([url]) => url)).toEqual([EN_INDEX_URL, FR_INDEX_URL]);

      mockPost.mockReset();
      mockPost.mockRejectedValueOnce(httpError(404, 'Index does not exist')).mockResolvedValueOnce(fixtureResponse());
      const res = await service.scrape(companyInput());
      expect(res.jobs).toHaveLength(8);
      expect(res.diagnostics).toBeUndefined();
    });

    it('an unknown company is an empty result with no diagnostic', async () => {
      mockPost.mockResolvedValue({ data: { hits: [], nbHits: 0 } });
      const res = await service.scrape(companyInput({ companySlug: 'nobody-here' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
    });

    it('a transport failure stops the walk and says so (fetch_error)', async () => {
      mockPost.mockRejectedValueOnce(
        Object.assign(new Error('getaddrinfo ENOTFOUND csekhvms53-dsn.algolia.net'), { code: 'ENOTFOUND' }),
      );
      const res = await service.scrape(companyInput());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('resolves the company from a companyUrl', async () => {
      mockPost.mockResolvedValueOnce(fixtureResponse());
      await service.scrape(
        companyInput({ companySlug: undefined, companyUrl: 'https://www.welcometothejungle.com/en/companies/Acme-Robotics/jobs' }),
      );
      expect(postCalls()[0][1]).toMatchObject({ facetFilters: [['organization.slug:acme-robotics']] });
    });
  });

  describe('hit mapping (B)', () => {
    let jobs: JobPostDto[];

    beforeEach(async () => {
      mockPost.mockResolvedValueOnce(fixtureResponse());
      jobs = (await service.scrape(companyInput())).jobs;
    });

    it('B1 remote matrix: only fulltime (or a remote title with no token) is remote', () => {
      const expectRemote = (ref: string, isRemote: boolean, wfh: string | undefined) => {
        const job = byRef(jobs, ref);
        expect({ ref, isRemote: job.isRemote, wfh: job.workFromHomeType }).toEqual({ ref, isRemote, wfh });
      };
      expectRemote('a1', false, 'Hybrid'); // partial
      expectRemote('b2', false, 'Hybrid'); // punctual
      expectRemote('c3', true, 'Remote'); // no token, "Full remote" title
      expectRemote('d4', false, undefined); // "no" beats "Remote Sommelier"
      expectRemote('e5', true, 'Remote'); // fulltime
      expectRemote('f6', false, undefined); // unknown: the old false positive
    });

    it('B2 description: summary, then missions as a list, then the profile', () => {
      const html = byRef(jobs, 'a1').description!;
      expect(html.indexOf('Build the control software')).toBeLessThan(html.indexOf('<ul>'));
      expect(html).toContain('<li>Design motion-planning services.</li>');
      expect(html).toContain('<li>Review code &amp; mentor juniors.</li>');
      expect(html.indexOf('</ul>')).toBeLessThan(html.indexOf('5 years'));
      expect(byRef(jobs, 'b2').description).toContain('Piloter la refonte du site.');
    });

    it('B2 description: missions survive plain-text and Markdown output', async () => {
      for (const descriptionFormat of [DescriptionFormat.PLAIN, DescriptionFormat.MARKDOWN]) {
        mockPost.mockResolvedValueOnce(fixtureResponse());
        const out = (await service.scrape(companyInput({ descriptionFormat }))).jobs;
        const text = byRef(out, 'a1').description!;
        expect(text).toContain('Design motion-planning services.');
        expect(text).toContain('Ship firmware updates <safely>.');
        expect(text).not.toContain('<li>');
      }
    });

    it('B3 compensation: structured first, text fallback, never a silent USD', () => {
      expect({ ...byRef(jobs, 'a1').compensation }).toEqual({
        interval: CompensationInterval.YEARLY,
        minAmount: 43000,
        maxAmount: 51000,
        currency: 'EUR',
      });
      expect(byRef(jobs, 'b2').compensation).toMatchObject({ interval: CompensationInterval.MONTHLY, currency: 'EUR' });
      expect({ ...byRef(jobs, 'c3').compensation }).toEqual({
        interval: CompensationInterval.YEARLY,
        minAmount: 90000,
        currency: 'USD',
      });
      // No currency on the structured fields: the description's "€32k - €36k" is used.
      expect(byRef(jobs, 'd4').compensation).toMatchObject({ minAmount: 32000, maxAmount: 36000, currency: 'EUR' });
      expect(byRef(jobs, 'e5').compensation).toBeUndefined();
      expect(byRef(jobs, 'f6').compensation).toBeUndefined(); // zero amounts
    });

    it('B4 jobType, with employmentType unchanged', () => {
      expect(byRef(jobs, 'a1').jobType).toEqual([JobType.FULL_TIME]);
      expect(byRef(jobs, 'a1').employmentType).toBe('Full Time');
      expect(byRef(jobs, 'b2').jobType).toEqual([JobType.APPRENTICESHIP]);
      expect(byRef(jobs, 'c3').jobType).toEqual([JobType.CONTRACT]);
      expect(byRef(jobs, 'd4').jobType).toEqual([JobType.OTHER]);
      expect(byRef(jobs, 'd4').employmentType).toBe('Vie');
      expect(byRef(jobs, 'e5').jobType).toEqual([JobType.TEMPORARY]);
      expect(byRef(jobs, 'f6').jobType).toEqual([JobType.PART_TIME]);
      expect(byRef(jobs, 'g7').jobType).toEqual([JobType.OTHER]);
      expect(byRef(jobs, 'h8').jobType).toEqual([JobType.INTERNSHIP]);
    });

    it('B5 every office is a location; the primary stays first; countryCode is set', () => {
      const a1 = byRef(jobs, 'a1');
      expect(a1.location).toMatchObject({ city: 'Paris', state: 'Ile-de-France', country: 'France' });
      expect(a1.locations?.map((l) => l.city)).toEqual(['Paris', 'Berlin']);
      expect(a1.countryCode).toBe('FR');
      // One office: unchanged single-entry list.
      expect(byRef(jobs, 'e5').locations).toHaveLength(1);
      expect(byRef(jobs, 'e5').countryCode).toBe('DE');
      // No city: the country-only office is still the location.
      expect(byRef(jobs, 'c3').location).toMatchObject({ country: 'France' });
      expect(byRef(jobs, 'c3').countryCode).toBe('FR');
    });

    it('B5 company metadata, job function and experience', () => {
      const a1 = byRef(jobs, 'a1');
      expect(a1.companyName).toBe('Acme Robotics');
      expect(a1.companyLogo).toBe('https://cdn.example.test/logos/acme-robotics.png');
      expect(a1.companyIndustry).toBe('IT / Digital, SaaS / Cloud Services');
      expect(a1.companyNumEmployees).toBe('800');
      expect(a1.companyDescription).toBe('Industrial robots for small factories.');
      expect(a1.jobFunction).toBe('Tech');
      expect(a1.department).toBe('Software Engineering');
      expect(a1.experienceRange).toBe('5+ years');
      const b2 = byRef(jobs, 'b2');
      expect(b2.companyLogo).toBeUndefined();
      expect(b2.companyNumEmployees).toBeUndefined();
      expect(b2.experienceRange).toBeUndefined();
    });

    it('B6 URL locale: a served locale is kept, any other becomes en', () => {
      expect(byRef(jobs, 'a1').jobUrl).toBe(
        'https://www.welcometothejungle.com/fr/companies/acme-robotics/jobs/robotics-software-engineer_paris_ACME_Ab12Cd3',
      );
      expect(byRef(jobs, 'a1').applyUrl).toBe(`${byRef(jobs, 'a1').jobUrl}/apply`);
      expect(byRef(jobs, 'e5').jobUrl).toBe(
        'https://www.welcometothejungle.com/en/companies/acme-robotics/jobs/data-analyst_munich_ACME_Qr90St1',
      );
      expect(byRef(jobs, 'h8').jobUrl).toContain('/es/companies/bistro-numerique/jobs/');
    });

    it('keeps the existing fields and adds the posting instant', () => {
      const a1 = byRef(jobs, 'a1');
      expect(a1).toMatchObject({
        id: 'wttj-a1000000-0000-4000-8000-000000000001',
        title: 'Robotics Software Engineer',
        site: Site.WTTJ,
        atsType: 'wttj',
        atsId: 'a1000000-0000-4000-8000-000000000001',
        datePosted: '2026-09-22',
        datePostedAt: '2026-09-22T15:06:42.000Z',
        datePostedPrecision: DatePostedPrecision.EXACT,
        datePostedBasis: DatePostedBasis.TIMESTAMP,
      });
    });
  });

  describe('pre-Spec-1705 behaviour stays reachable', () => {
    it('WTTJ_REMOTE_MODE=legacy restores the old remote flag', async () => {
      process.env[WTTJ_ENV.REMOTE_MODE] = 'legacy';
      mockPost.mockResolvedValueOnce(fixtureResponse());
      const jobs = (await service.scrape(companyInput())).jobs;
      expect(byRef(jobs, 'f6').isRemote).toBe(true); // unknown
      expect(byRef(jobs, 'a1').isRemote).toBe(true); // partial
      expect(byRef(jobs, 'g7').isRemote).toBe(false); // no
    });

    it('WTTJ_DESCRIPTION_LAYOUT=legacy restores the old body', async () => {
      process.env[WTTJ_ENV.DESCRIPTION_LAYOUT] = 'legacy';
      mockPost.mockResolvedValueOnce(fixtureResponse());
      const jobs = (await service.scrape(companyInput())).jobs;
      expect(byRef(jobs, 'a1').description).toBe('<p>You have <strong>5 years</strong> of C++ experience.</p>');
    });

    it('WTTJ_URL_LOCALE_GUARD=off uses the posting language as before', async () => {
      process.env[WTTJ_ENV.URL_LOCALE_GUARD] = 'off';
      mockPost.mockResolvedValueOnce(fixtureResponse());
      const jobs = (await service.scrape(companyInput())).jobs;
      expect(byRef(jobs, 'e5').jobUrl).toContain('/de/companies/acme-robotics/jobs/');
    });

    it('the posting-time kill switch drops the instant but keeps datePosted', async () => {
      process.env[POSTING_TIME_ENV] = 'off';
      mockPost.mockResolvedValueOnce(fixtureResponse());
      const a1 = byRef((await service.scrape(companyInput())).jobs, 'a1');
      expect(a1.datePosted).toBe('2026-09-22');
      expect(a1.datePostedAt).toBeUndefined();
    });

    it('WTTJ_USER_AGENT_MODE=browser sends the old user agent', async () => {
      process.env[WTTJ_ENV.USER_AGENT_MODE] = 'browser';
      mockPost.mockResolvedValueOnce(fixtureResponse());
      await service.scrape(companyInput());
      expect(mockSetHeaders.mock.calls[0][0]['User-Agent']).toBe(WTTJ_BROWSER_USER_AGENT);
    });
  });

  describe('politeness', () => {
    it('paces requests, caps the timeout and sends the identifying user agent', async () => {
      mockPost.mockResolvedValueOnce(fixtureResponse());
      await service.scrape(companyInput());
      expect(mockCreateHttpClient).toHaveBeenCalledTimes(1);
      expect(mockCreateHttpClient.mock.calls[0][0]).toMatchObject({
        timeout: 15,
        requestTimeout: 15,
        userAgent: WTTJ_HONEST_USER_AGENT,
        rateDelayMin: 0.5,
        rateDelayMax: 1,
      });
      expect(mockSetHeaders.mock.calls[0][0]).toMatchObject({
        'User-Agent': WTTJ_HONEST_USER_AGENT,
        Referer: 'https://www.welcometothejungle.com/',
      });
    });

    it("a caller's user agent and slower pacing win", async () => {
      mockPost.mockResolvedValueOnce(fixtureResponse());
      await service.scrape(companyInput({ userAgent: 'MyBot/2.0', rateDelayMin: 3, rateDelayMax: 5, requestTimeout: 5 }));
      expect(mockCreateHttpClient.mock.calls[0][0]).toMatchObject({
        userAgent: 'MyBot/2.0',
        rateDelayMin: 3,
        rateDelayMax: 5,
        timeout: 5,
      });
      expect(mockSetHeaders.mock.calls[0][0]['User-Agent']).toBe('MyBot/2.0');
    });
  });

  describe('mode selection (A1)', () => {
    it('no company and no criteria: [] and no request', async () => {
      const res = await service.scrape(new ScraperInputDto({ siteType: [Site.WTTJ], resultsWanted: 5 }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('bad_input');
      expect(res.diagnostics?.detail).toBe('no companySlug or companyUrl');
      expect(mockCreateHttpClient).not.toHaveBeenCalled();
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('by default scrape() stays company-only: a search term without a company makes no request', async () => {
      const res = await service.scrape(new ScraperInputDto({ siteType: [Site.WTTJ], searchTerm: 'data' }));
      expect(res.jobs).toEqual([]);
      // says why it is empty and how to opt in, rather than reading as 'no jobs'
      expect(res.diagnostics?.reason).toBe('bad_input');
      expect(res.diagnostics?.detail).toContain('WTTJ_BOARD_MODE=on');
      expect(mockPost).not.toHaveBeenCalled();
      expect(mockCreateHttpClient).not.toHaveBeenCalled();
    });

    it('WTTJ_BOARD_MODE=on, no company and a search term: board mode', async () => {
      process.env[WTTJ_ENV.BOARD_MODE] = 'on';
      mockPost.mockResolvedValueOnce(boardPage(0, 5, { nbPages: 1 }));
      const res = await service.scrape(new ScraperInputDto({ siteType: [Site.WTTJ], searchTerm: 'data', resultsWanted: 5 }));
      expect(res.jobs).toHaveLength(5);
      const [url, body] = postCalls()[0];
      expect(url).toBe(EN_INDEX_URL);
      expect(body).toEqual({
        query: 'data',
        hitsPerPage: 5,
        page: 0,
        attributesToHighlight: [],
        attributesToSnippet: [],
        attributesToRetrieve: [...WTTJ_BOARD_ATTRIBUTES],
      });
      expect(JSON.stringify(body)).not.toContain('organization.slug');
    });

    it.each([
      ['location', { location: 'Paris' }],
      ['hoursOld', { hoursOld: 24 }],
      ['isRemote', { isRemote: true }],
      ['jobType', { jobType: JobType.FULL_TIME }],
    ])('WTTJ_BOARD_MODE=on, no company and %s: board mode', async (_label, extra) => {
      process.env[WTTJ_ENV.BOARD_MODE] = 'on';
      mockPost.mockResolvedValueOnce(boardPage(0, 1, { nbPages: 1 }));
      await service.scrape(new ScraperInputDto({ siteType: [Site.WTTJ], resultsWanted: 1, ...extra }));
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(postCalls()[0][1]).toHaveProperty('attributesToRetrieve');
    });

    it.each(['off', 'false', 'maybe'])('WTTJ_BOARD_MODE=%s keeps scrape() company-only', async (value) => {
      process.env[WTTJ_ENV.BOARD_MODE] = value;
      const res = await service.scrape(new ScraperInputDto({ siteType: [Site.WTTJ], searchTerm: 'data' }));
      expect(res.jobs).toEqual([]);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('a company plus search criteria stays in company mode', async () => {
      mockPost.mockResolvedValueOnce(fixtureResponse());
      await service.scrape(companyInput({ searchTerm: 'engineer', isRemote: true }));
      expect(postCalls()[0][1]).toEqual({
        query: '',
        hitsPerPage: 100,
        page: 0,
        facetFilters: [['organization.slug:acme-robotics']],
      });
    });

    it('scrapeBoard with an empty input returns the newest postings', async () => {
      mockPost.mockResolvedValueOnce(boardPage(0, 15, { nbPages: 6000 }));
      const res = await service.scrapeBoard({} as ScraperInputDto);
      expect(res.jobs).toHaveLength(15);
      expect(postCalls()[0][1]).toMatchObject({ query: '', hitsPerPage: 15, page: 0 });
      expect(postCalls()[0][1]).not.toHaveProperty('facetFilters');
    });

    it('scrapeBoard ignores a company', async () => {
      mockPost.mockResolvedValueOnce(boardPage(0, 2, { nbPages: 1 }));
      await service.scrapeBoard(new ScraperInputDto({ companySlug: 'acme-robotics', resultsWanted: 2 }));
      expect(JSON.stringify(postCalls()[0][1])).not.toContain('organization.slug');
    });
  });

  describe('board search (A2/A3)', () => {
    it('sends the filters built from the input', async () => {
      mockPost.mockResolvedValueOnce(boardPage(0, 3, { nbPages: 1 }));
      const res = await service.scrapeBoard(
        new ScraperInputDto({
          searchTerm: 'developer',
          location: 'Paris, France',
          isRemote: true,
          jobType: JobType.INTERNSHIP,
          hoursOld: 24,
          resultsWanted: 3,
        }),
      );
      const body = postCalls()[0][1];
      expect(body.facetFilters).toEqual([
        ['offices.city:Paris', 'offices.state:Paris'],
        ['offices.country_code:FR'],
        ['remote:fulltime'],
        ['contract_type:internship'],
      ]);
      expect(body.numericFilters).toEqual([expect.stringMatching(/^published_at_timestamp>\d+$/)]);
      const cutoff = Number(String((body.numericFilters as string[])[0]).split('>')[1]);
      expect(Math.abs(Date.now() / 1000 - 86400 - cutoff)).toBeLessThan(120);
      expect(res.jobs.every((job) => job.isRemote === true)).toBe(true);
      expect(res.jobs.every((job) => job.site === Site.WTTJ)).toBe(true);
    });

    it('150 wanted reads pages 0 and 1 of 100 from the _en index only', async () => {
      mockPost
        .mockResolvedValueOnce(boardPage(0, 100, { nbPages: 10 }))
        .mockResolvedValueOnce(boardPage(100, 100, { nbPages: 10 }));
      const res = await service.scrapeBoard(new ScraperInputDto({ searchTerm: 'data', resultsWanted: 150 }));
      expect(res.jobs).toHaveLength(150);
      expect(res.diagnostics).toBeUndefined();
      expect(postCalls().map(([url, body]) => [url, body.page, body.hitsPerPage])).toEqual([
        [EN_INDEX_URL, 0, 100],
        [EN_INDEX_URL, 1, 100],
      ]);
    });

    it('offset 130 + 20 wanted reads one page and skips to position 130', async () => {
      mockPost.mockResolvedValueOnce(boardPage(125, 25, { nbPages: 40 }));
      const res = await service.scrapeBoard(new ScraperInputDto({ searchTerm: 'data', offset: 130, resultsWanted: 20 }));
      expect(postCalls().map(([, body]) => [body.page, body.hitsPerPage])).toEqual([[5, 25]]);
      expect(res.jobs).toHaveLength(20);
      expect(res.jobs[0].title).toBe('Role 130');
      expect(res.jobs[19].title).toBe('Role 149');
    });

    it('offset 990 + 50 wanted stops at the window and reports partial', async () => {
      mockPost.mockResolvedValueOnce(boardPage(990, 10, { nbHits: 5000, nbPages: 100 }));
      const res = await service.scrapeBoard(new ScraperInputDto({ searchTerm: 'data', offset: 990, resultsWanted: 50 }));
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(postCalls()[0][1]).toMatchObject({ page: 99, hitsPerPage: 10 });
      expect(res.jobs).toHaveLength(10);
      expect(res.diagnostics).toEqual({
        reason: 'partial',
        detail: 'Welcome to the Jungle search window is capped at 1000 hits per query',
      });
    });

    it('a request the window cuts short is not partial when the board has no more', async () => {
      mockPost.mockResolvedValueOnce(boardPage(990, 5, { nbHits: 995, nbPages: 100 }));
      const res = await service.scrapeBoard(new ScraperInputDto({ searchTerm: 'data', offset: 990, resultsWanted: 50 }));
      expect(res.jobs).toHaveLength(5);
      expect(res.diagnostics).toBeUndefined();
    });

    it('offset 1000 is bad_input and makes no request', async () => {
      const res = await service.scrapeBoard(new ScraperInputDto({ searchTerm: 'data', offset: 1000 }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toEqual({ reason: 'bad_input', detail: 'offset beyond the 1000-hit search window' });
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('stops on an empty page and at nbPages', async () => {
      mockPost.mockResolvedValueOnce(boardPage(0, 100, { nbPages: 5 })).mockResolvedValueOnce({ data: { hits: [] } });
      expect((await service.scrapeBoard(new ScraperInputDto({ resultsWanted: 300 }))).jobs).toHaveLength(100);
      expect(mockPost).toHaveBeenCalledTimes(2);

      mockPost.mockReset();
      mockPost.mockResolvedValueOnce(boardPage(0, 100, { nbHits: 100, nbPages: 1 }));
      expect((await service.scrapeBoard(new ScraperInputDto({ resultsWanted: 300 }))).jobs).toHaveLength(100);
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('never asks for a page past the 1,000-hit window', async () => {
      for (let p = 0; p < 10; p++) mockPost.mockResolvedValueOnce(boardPage(p * 100, 100));
      const res = await service.scrapeBoard(new ScraperInputDto({ resultsWanted: 5000 }));
      expect(res.jobs).toHaveLength(1000);
      expect(mockPost).toHaveBeenCalledTimes(10);
      expect(Math.max(...postCalls().map(([, body]) => body.page as number))).toBe(9);
      expect(res.diagnostics?.reason).toBe('partial');
    });

    it('falls back to _fr only when _en is missing', async () => {
      mockPost.mockRejectedValueOnce(httpError(404, 'Index does not exist')).mockResolvedValueOnce(boardPage(0, 3, { nbPages: 1 }));
      const res = await service.scrapeBoard(new ScraperInputDto({ searchTerm: 'data', resultsWanted: 3 }));
      expect(res.jobs).toHaveLength(3);
      expect(postCalls().map(([url]) => url)).toEqual([EN_INDEX_URL, FR_INDEX_URL]);
    });

    it('an HTTP error mid-walk keeps the earlier page and reports it', async () => {
      mockPost.mockResolvedValueOnce(boardPage(0, 100, { nbPages: 10 })).mockRejectedValueOnce(httpError(503));
      const res = await service.scrapeBoard(new ScraperInputDto({ searchTerm: 'data', resultsWanted: 150 }));
      expect(res.jobs).toHaveLength(100);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('a transport failure on the first page is fetch_error with no jobs', async () => {
      mockPost.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      const res = await service.scrapeBoard(new ScraperInputDto({ searchTerm: 'data' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('skips a hit that cannot be linked, and one malformed hit does not stop the page', async () => {
      const throwing = boardHit(3);
      Object.defineProperty(throwing, 'summary', {
        enumerable: true,
        get() {
          throw new Error('malformed summary');
        },
      });
      mockPost.mockResolvedValueOnce({
        data: {
          hits: [
            boardHit(0, { organization: { name: 'No Slug Ltd' } }),
            boardHit(1, { name: null }),
            boardHit(2, { offices: 'not-an-array' as unknown as WttjJobHit['offices'] }),
            throwing,
            boardHit(4),
          ],
          nbPages: 1,
        },
      });
      const res = await service.scrapeBoard(new ScraperInputDto({ resultsWanted: 5 }));
      expect(res.jobs.map((j) => j.title)).toEqual(['Role 2', 'Role 4']);
      expect(res.diagnostics).toBeUndefined();
    });

    it('deduplicates by reference', async () => {
      mockPost.mockResolvedValueOnce({ data: { hits: [boardHit(1), boardHit(1), boardHit(2)], nbPages: 1 } });
      const res = await service.scrapeBoard(new ScraperInputDto({ resultsWanted: 3 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual(['ref-0001', 'ref-0002']);
    });
  });

  describe('credential self-heal (C)', () => {
    it('re-reads the key once, retries once, and returns the jobs', async () => {
      mockPost
        .mockRejectedValueOnce(httpError(403, 'Invalid Application-ID or API key'))
        .mockResolvedValueOnce(fixtureResponse());
      mockGet.mockResolvedValueOnce({ data: DETAIL_HTML });

      const res = await service.scrape(companyInput());

      expect(res.jobs).toHaveLength(8);
      expect(res.diagnostics).toBeUndefined();
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockPost).toHaveBeenCalledTimes(2);
      const [retryUrl, retryBody, retryConfig] = postCalls()[1];
      expect(retryUrl).toBe('https://testapp123-dsn.algolia.net/1/indexes/wttj_jobs_production_en/query');
      expect(retryBody).toEqual(postCalls()[0][1]);
      expect(retryConfig?.headers?.['x-algolia-api-key']).toBe(FRESH_KEY);
      expect(retryConfig?.headers?.['x-algolia-application-id']).toBe('TESTAPP123');
    });

    it('fetches the credential page politely: pinned host, no retries, paced, text', async () => {
      mockPost
        .mockRejectedValueOnce(httpError(401))
        .mockResolvedValueOnce(fixtureResponse());
      mockGet.mockResolvedValueOnce({ data: DETAIL_HTML });
      await service.scrape(companyInput());

      const pageClientOptions = mockCreateHttpClient.mock.calls[1][0];
      expect(pageClientOptions).toMatchObject({
        retries: 0,
        rateDelayMin: 2,
        allowedRedirectHosts: WTTJ_CREDENTIAL_HOSTS,
        userAgent: WTTJ_HONEST_USER_AGENT,
      });
      const [url, config] = mockGet.mock.calls[0];
      expect(url).toMatch(/^https:\/\/www\.welcometothejungle\.com\/[a-z]{2}\/companies\/[^/?#]+\/jobs\/[^/?#]+$/);
      expect(config).toMatchObject({ responseType: 'text' });
    });

    it('later queries in the process use the rediscovered key directly', async () => {
      mockPost
        .mockRejectedValueOnce(httpError(403, 'Invalid Application-ID or API key'))
        .mockResolvedValue(fixtureResponse());
      mockGet.mockResolvedValueOnce({ data: DETAIL_HTML });
      await service.scrape(companyInput());
      await service.scrape(companyInput());
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(postCalls()[2][2]?.headers?.['x-algolia-api-key']).toBe(FRESH_KEY);
    });

    it('a key that cannot be rediscovered is blocked, not empty', async () => {
      mockPost.mockRejectedValue(httpError(403, 'Invalid Application-ID or API key'));
      mockGet.mockRejectedValue(new Error('socket hang up'));
      const res = await service.scrape(companyInput());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toEqual({
        reason: 'blocked',
        detail: 'Welcome to the Jungle search credentials were rejected and could not be rediscovered',
      });
      // One query, no retry, no second index.
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('a page that yields the same key is not retried', async () => {
      mockPost.mockRejectedValue(httpError(403));
      mockGet.mockResolvedValue({
        data: `"ALGOLIA_APPLICATION_ID":"${WTTJ_ALGOLIA_APP_ID}","ALGOLIA_API_KEY_CLIENT":"${WTTJ_ALGOLIA_API_KEY}"`,
      });
      const res = await service.scrape(companyInput());
      expect(res.diagnostics?.reason).toBe('blocked');
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('a refusal after earlier pages keeps them (partial upstream)', async () => {
      mockPost
        .mockResolvedValueOnce(boardPage(0, 100, { nbPages: 10 }))
        .mockRejectedValueOnce(httpError(403, 'Invalid Application-ID or API key'));
      mockGet.mockResolvedValue({ data: '<html>nothing here</html>' });
      const res = await service.scrapeBoard(new ScraperInputDto({ searchTerm: 'data', resultsWanted: 150 }));
      expect(res.jobs).toHaveLength(100);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('a 200 carrying the refusal message counts as a refusal', async () => {
      mockPost
        .mockResolvedValueOnce({ data: { message: 'Invalid Application-ID or API key', status: 403 } })
        .mockResolvedValueOnce(boardPage(0, 2, { nbPages: 1 }));
      mockGet.mockResolvedValueOnce({ data: DETAIL_HTML });
      const res = await service.scrapeBoard(new ScraperInputDto({ searchTerm: 'data', resultsWanted: 2 }));
      expect(res.jobs).toHaveLength(2);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('WTTJ_CREDENTIAL_REFRESH=off never fetches a page and reports blocked', async () => {
      process.env[WTTJ_ENV.CREDENTIAL_REFRESH] = 'off';
      mockPost.mockRejectedValue(httpError(403));
      const res = await service.scrape(companyInput());
      expect(res.diagnostics?.reason).toBe('blocked');
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockCreateHttpClient).toHaveBeenCalledTimes(1);
    });

    it('two concurrent refused scrapes trigger one refresh', async () => {
      mockPost
        .mockRejectedValueOnce(httpError(403, 'Invalid Application-ID or API key'))
        .mockRejectedValueOnce(httpError(403, 'Invalid Application-ID or API key'))
        .mockResolvedValue(fixtureResponse());
      mockGet.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ data: DETAIL_HTML }), 5)),
      );
      const [a, b] = await Promise.all([service.scrape(companyInput()), service.scrape(companyInput())]);
      expect(a.jobs).toHaveLength(8);
      expect(b.jobs).toHaveLength(8);
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('the last served detail URL is the first page tried', async () => {
      mockPost.mockResolvedValueOnce(fixtureResponse());
      const jobs = (await service.scrape(companyInput())).jobs;
      const lastUrl = jobs[jobs.length - 1].jobUrl;

      mockPost.mockReset();
      mockPost.mockRejectedValueOnce(httpError(403)).mockResolvedValueOnce(fixtureResponse());
      mockGet.mockResolvedValueOnce({ data: DETAIL_HTML });
      await service.scrape(companyInput());
      expect(mockGet.mock.calls[0][0]).toBe(lastUrl);
    });
  });
});
