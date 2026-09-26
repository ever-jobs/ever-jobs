import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CompensationInterval,
  DatePostedBasis,
  DatePostedPrecision,
  DescriptionFormat,
  JobType,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
const mockCreateHttpClient = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: (...args: unknown[]) => {
      mockCreateHttpClient(...args);
      return { get: mockGet, setHeaders: mockSetHeaders };
    },
  };
});

import { InhireService } from '@ever-jobs/source-ats-inhire';
import { inhireRuntime, resetInhireState } from '../src/inhire.state';
import {
  INHIRE_DEFAULT_DETAIL_BUDGET,
  INHIRE_DETAIL_CONCURRENCY_ENV,
  INHIRE_DETAIL_MAX_CONSECUTIVE_FAILURES,
  INHIRE_MAX_DETAIL_FETCHES,
  INHIRE_MAX_LIST_ITEMS,
  INHIRE_MIN_INTERVAL_ENV,
  INHIRE_MIN_INTERVAL_MS,
  INHIRE_SITE,
  INHIRE_USER_AGENT,
} from '../src/inhire.constants';

const SITE: Site = Site.INHIRE;

const API_PREFIX = 'https://api.inhire.app/job-posts/public/pages/';
const LIST_URL = `${API_PREFIX}lean`;

const ID = {
  r1: '11111111-1111-4111-8111-111111111111',
  r2: '22222222-2222-4222-8222-222222222222',
  r3: '33333333-3333-4333-8333-333333333333',
  r4: '44444444-4444-4444-8444-444444444444',
  r5: '55555555-5555-4555-8555-555555555555',
  r6: '66666666-6666-4666-8666-666666666666',
};

const FIX = join(__dirname, 'fixtures');
const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(FIX, name), 'utf-8')) as T;

type Json = Record<string, unknown>;

function defaultDetails(): Record<string, Json> {
  return {
    [ID.r1]: fixture<Json>('detail-1.json'),
    [ID.r2]: fixture<Json>('detail-2.json'),
    [ID.r3]: fixture<Json>('detail-3.json'),
    [ID.r4]: fixture<Json>('detail-4.json'),
    [ID.r5]: fixture<Json>('detail-5.json'),
  };
}

function httpError(status: number, data?: unknown): Error {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    response?: { status: number; data?: unknown };
  };
  err.response = { status, data };
  return err;
}

interface RouteOptions {
  list?: unknown | Error;
  details?: Record<string, unknown | Error>;
  /** Response for a detail id not in `details` (role 6 by default: a 500). */
  missing?: unknown | Error;
  /** Called at the start of every request; may await to hold the request open. */
  onRequest?: (url: string) => Promise<void> | void;
}

/** Route the mocked GET by URL: the lean list, or a detail by id. */
function route(options: RouteOptions = {}): void {
  const list = 'list' in options ? options.list : fixture('list-acme.json');
  const details = options.details ?? defaultDetails();
  const missing = 'missing' in options ? options.missing : httpError(500);
  mockGet.mockImplementation(async (url: string) => {
    await options.onRequest?.(url);
    let value: unknown;
    if (url === LIST_URL) {
      value = list;
    } else if (url.startsWith(API_PREFIX)) {
      const id = url.slice(API_PREFIX.length);
      value = id in details ? details[id] : missing;
    } else {
      throw new Error(`unexpected url ${url}`);
    }
    if (value instanceof Error) throw value;
    return { data: value };
  });
}

function input(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return new ScraperInputDto({ siteType: [SITE], companySlug: 'acme-br', resultsWanted: 100, ...overrides });
}

const requestedUrls = (): string[] => mockGet.mock.calls.map((call) => call[0] as string);
const detailIds = (): string[] =>
  requestedUrls()
    .filter((url) => url !== LIST_URL)
    .map((url) => url.slice(API_PREFIX.length));

/** A synthetic tenant list of `n` distinct roles, with a published detail for each. */
function syntheticBoard(n: number): { list: Json[]; details: Record<string, Json> } {
  const list: Json[] = [];
  const details: Record<string, Json> = {};
  const base = fixture<Json>('detail-1.json');
  for (let i = 0; i < n; i++) {
    const jobId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    list.push({ jobId, displayName: `Role ${i}`, link: `https://acme-br.inhire.com.br/vagas/${jobId}` });
    details[jobId] = { ...base, jobId, displayName: `Role ${i}` };
  }
  return { list, details };
}

describe('InhireService (Spec 1692)', () => {
  it('registers under Site.INHIRE', () => {
    expect(INHIRE_SITE).toBe(Site.INHIRE);
    expect(Site.INHIRE).toBe('inhire');
  });

  let service: InhireService;
  let clock: number;
  const realRuntime = { ...inhireRuntime };

  beforeEach(() => {
    mockGet.mockReset();
    mockSetHeaders.mockReset();
    mockCreateHttpClient.mockReset();
    delete process.env[INHIRE_DETAIL_CONCURRENCY_ENV];
    delete process.env[INHIRE_MIN_INTERVAL_ENV];
    resetInhireState();
    clock = Date.parse('2026-09-24T12:00:00.000Z');
    // Virtual time: each sleep registers a timer, and one macrotask per timer
    // fires the earliest pending one, advancing the clock to it. Concurrent
    // sleepers therefore wake in deadline order, as they would in real time.
    const timers: Array<{ at: number; resolve: () => void }> = [];
    inhireRuntime.now = () => clock;
    inhireRuntime.sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push({ at: clock + ms, resolve });
        setImmediate(() => {
          timers.sort((a, b) => a.at - b.at);
          const next = timers.shift();
          if (!next) return;
          clock = Math.max(clock, next.at);
          next.resolve();
        });
      });
    service = new InhireService();
  });

  afterAll(() => {
    Object.assign(inhireRuntime, realRuntime);
    resetInhireState();
    delete process.env[INHIRE_DETAIL_CONCURRENCY_ENV];
    delete process.env[INHIRE_MIN_INTERVAL_ENV];
  });

  describe('tenant input', () => {
    it('returns bad_input and makes no request without a companySlug or companyUrl', async () => {
      const res = await service.scrape(input({ companySlug: undefined }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('bad_input');
      expect(mockGet).not.toHaveBeenCalled();
      expect(mockCreateHttpClient).not.toHaveBeenCalled();
    });

    it.each([
      [{ companySlug: 'evil\r\nX: y' }],
      [{ companySlug: 'a..b' }],
      [{ companySlug: 'api' }],
      [{ companySlug: 'https://olist.example.com' }],
      [{ companySlug: 'https://olist.inhire.app.evil.example/' }],
      [{ companySlug: undefined, companyUrl: 'https://olist.example.com/vagas' }],
      [{ companySlug: undefined, companyUrl: 'olist' }],
      [{ companySlug: undefined, companyUrl: 'http://169.254.169.254/latest' }],
    ])('refuses %j with bad_input and no request', async (overrides) => {
      const res = await service.scrape(input(overrides as Partial<ScraperInputDto>));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('bad_input');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it.each([
      [{ companySlug: 'acme-br' }],
      [{ companySlug: 'ACME-BR' }],
      [{ companySlug: 'acme-br.inhire.app' }],
      [{ companySlug: `https://acme-br.inhire.com.br/vagas/${ID.r1}` }],
      [{ companySlug: undefined, companyUrl: 'https://acme-br.inhire.app/vagas' }],
      [{ companySlug: '', companyUrl: 'https://acme-br.inhire.com.br/' }],
    ])('resolves %j to tenant acme-br', async (overrides) => {
      route();
      await service.scrape(input({ ...(overrides as Partial<ScraperInputDto>), descriptionDepth: 'board' }));
      expect(mockGet).toHaveBeenCalledTimes(1);
      const [url, config] = mockGet.mock.calls[0];
      expect(url).toBe(LIST_URL);
      expect(config.headers['X-Tenant']).toBe('acme-br');
    });
  });

  describe('requests', () => {
    it('sends every request to the fixed API origin with the tenant header and an honest client', async () => {
      route();
      await service.scrape(input());

      expect(requestedUrls().length).toBeGreaterThan(1);
      for (const [url, config] of mockGet.mock.calls) {
        expect(url.startsWith(API_PREFIX)).toBe(true);
        expect(config.headers).toEqual({ 'X-Tenant': 'acme-br' });
      }

      const options = mockCreateHttpClient.mock.calls[0][0];
      expect(options.userAgent).toBe(INHIRE_USER_AGENT);
      expect(options.allowedRedirectHosts).toEqual(['api.inhire.app']);
      expect(options.requestTimeout).toBe(15);
      expect(options.timeout).toBe(15);

      const headers = mockSetHeaders.mock.calls[0][0] as Record<string, string>;
      expect(headers['User-Agent']).toBe(INHIRE_USER_AGENT);
      expect(headers['User-Agent']).toMatch(/compatible; EverJobs\/1\.0/);
      expect(headers.Accept).toBe('application/json');
      for (const name of Object.keys(headers)) {
        expect(name.toLowerCase()).not.toMatch(/^sec-|^x-inhire/);
      }
    });

    it('only shortens the request timeout and passes retry / rate-delay options through', async () => {
      route({ list: [] });
      await service.scrape(
        input({ requestTimeout: 5, retries: 1, retryDelay: 250, rateDelayMin: 1, rateDelayMax: 2, proxies: ['p:1'] }),
      );
      const options = mockCreateHttpClient.mock.calls[0][0];
      expect(options).toEqual(
        expect.objectContaining({
          requestTimeout: 5,
          timeout: 5,
          retries: 1,
          retryDelay: 250,
          rateDelayMin: 1,
          rateDelayMax: 2,
          proxies: ['p:1'],
        }),
      );
    });

    it('does not request a detail for a row without a UUID, a duplicate row, or past the matches needed', async () => {
      route();
      await service.scrape(input());
      const ids = detailIds();
      expect(ids).not.toContain('not-a-uuid');
      expect(ids.filter((id) => id === ID.r1)).toHaveLength(1);
      expect(ids).toEqual([ID.r1, ID.r2, ID.r3, ID.r4, ID.r5, ID.r6]);
    });
  });

  describe('mapping', () => {
    it('maps role 1 fully', async () => {
      route();
      const res = await service.scrape(input());
      const job = res.jobs.find((j) => j.atsId === ID.r1)!;

      expect(job).toBeDefined();
      expect(job.id).toBe(`inhire-${ID.r1}`);
      expect(job.site).toBe(SITE);
      expect(job.atsType).toBe('inhire');
      expect(job.title).toBe('Desenvolvedor Backend Sênior');
      expect(job.companyName).toBe('Acme Brasil');
      expect(job.jobUrl).toBe(`https://acme-br.inhire.com.br/vagas/${ID.r1}`);
      expect(job.applyUrl).toBe(job.jobUrl);
      expect(job.companyUrl).toBe('https://acme-br.inhire.com.br/vagas');
      expect(job.isRemote).toBe(true);
      expect(job.workFromHomeType).toBe('Remote');
      expect(job.countryCode).toBe('BR');
      expect(job.location?.country).toBe('Brazil');
      expect(job.locations?.[0]?.country).toBe('Brazil');
      expect(job.datePosted).toBe('2026-09-20');
      expect(job.datePostedAt).toBe('2026-09-20T15:30:00.000Z');
      expect(job.datePostedPrecision).toBe(DatePostedPrecision.EXACT);
      expect(job.datePostedBasis).toBe(DatePostedBasis.TIMESTAMP);
      expect(job.jobType).toEqual([JobType.FULL_TIME]);
      expect(job.employmentType).toBe('CLT');
      expect(job.companyLogo).toBe('https://files.inhire.app/pages/career/logo_acme-br.png');
      expect(job.bannerPhotoUrl).toBe('https://files.inhire.app/pages/career/banner_acme-br.png');
      expect(job.companyDescription).toBe('A Acme é uma empresa fictícia usada em testes.');
      expect(job.emails).toContain('vagas@acme-br.example');
      expect(job.department).toBeNull();
      expect(job.compensation).toBeNull();
    });

    it('builds Brazilian locations with the country added', async () => {
      route();
      const res = await service.scrape(input());
      const saoPaulo = res.jobs.find((j) => j.atsId === ID.r2)!;
      expect(saoPaulo.location).toEqual(
        expect.objectContaining({ city: 'São Paulo', state: 'SP', country: 'Brazil' }),
      );
      expect(saoPaulo.countryCode).toBe('BR');
      expect(saoPaulo.isRemote).toBe(false);
      expect(saoPaulo.workFromHomeType).toBe('Hybrid');

      const curitiba = res.jobs.find((j) => j.atsId === ID.r3)!;
      expect(curitiba.location).toEqual(
        expect.objectContaining({ city: 'Curitiba', state: 'PR', country: 'Brazil' }),
      );
      expect(curitiba.isRemote).toBe(false);
      expect(curitiba.workFromHomeType).toBeNull();
    });

    it('maps contract types (PJ, Estágio, none)', async () => {
      route();
      const res = await service.scrape(input());
      const byId = (id: string) => res.jobs.find((j) => j.atsId === id)!;
      expect(byId(ID.r2).jobType).toEqual([JobType.CONTRACT]);
      expect(byId(ID.r2).employmentType).toBe('PJ');
      expect(byId(ID.r3).jobType).toEqual([JobType.INTERNSHIP]);
      expect(byId(ID.r5).jobType).toBeNull();
      expect(byId(ID.r5).employmentType).toBeNull();
    });

    it('skips a closed role, a row without a UUID and a duplicate', async () => {
      route();
      const res = await service.scrape(input());
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2, ID.r3, ID.r5]);
    });

    it('ignores a list link on a foreign host and builds the canonical URL', async () => {
      route();
      const res = await service.scrape(input());
      const job = res.jobs.find((j) => j.atsId === ID.r5)!;
      expect(job.jobUrl).toBe(`https://acme-br.inhire.com.br/vagas/${ID.r5}`);
      expect(job.companyUrl).toBe('https://acme-br.inhire.com.br/vagas');
      expect(JSON.stringify(res.jobs)).not.toContain('evil.example.net');
    });

    it('falls back to the list title and the de-slugified tenant', async () => {
      const details = defaultDetails();
      details[ID.r1] = { ...details[ID.r1], displayName: '  ', tenantName: null };
      route({ details });
      const res = await service.scrape(input({ resultsWanted: 1 }));
      expect(res.jobs[0].title).toBe('Desenvolvedor Backend Sênior');
      expect(res.jobs[0].companyName).toBe('Acme Br');
    });

    it('refuses non-https logo and banner URLs', async () => {
      const details = defaultDetails();
      details[ID.r1] = {
        ...details[ID.r1],
        logo: 'http://files.inhire.app/logo.png',
        background: ['javascript:alert(1)', 'https://files.inhire.app/banner-2.png'],
      };
      route({ details });
      const res = await service.scrape(input({ resultsWanted: 1 }));
      expect(res.jobs[0].companyLogo).toBeNull();
      expect(res.jobs[0].bannerPhotoUrl).toBe('https://files.inhire.app/banner-2.png');
    });

    it('falls back from publishedAt to createdAt, then lastPublishedAt', async () => {
      const details = defaultDetails();
      details[ID.r1] = { ...details[ID.r1], publishedAt: null, createdAt: '2026-09-18T08:00:00.000Z' };
      details[ID.r2] = { ...details[ID.r2], publishedAt: '', createdAt: undefined };
      details[ID.r3] = {
        ...details[ID.r3],
        publishedAt: undefined,
        createdAt: undefined,
        lastPublishedAt: undefined,
      };
      route({ details });
      const res = await service.scrape(input({ resultsWanted: 3 }));
      expect(res.jobs.map((j) => j.datePosted)).toEqual(['2026-09-18', '2026-09-12', null]);
    });
  });

  describe('descriptionFormat', () => {
    it('returns the HTML unchanged', async () => {
      route();
      const res = await service.scrape(input({ descriptionFormat: DescriptionFormat.HTML, resultsWanted: 1 }));
      expect(res.jobs[0].description).toBe(fixture<Json>('detail-1.json').description);
    });

    it('converts to Markdown without tags', async () => {
      route();
      const res = await service.scrape(input({ descriptionFormat: DescriptionFormat.MARKDOWN, resultsWanted: 1 }));
      const description = res.jobs[0].description!;
      expect(description).not.toMatch(/<[a-z/]/i);
      expect(description).toContain('missão');
      expect(description).toContain('Node.js');
    });

    it('decodes every entity in plain text', async () => {
      route();
      const res = await service.scrape(input({ descriptionFormat: DescriptionFormat.PLAIN, resultsWanted: 1 }));
      const description = res.jobs[0].description!;
      expect(description).toContain('missão');
      expect(description).toContain('gestão');
      expect(description).not.toContain('&atilde;');
      expect(description).not.toMatch(/<[a-z/]/i);
    });

    it('leaves the description null when the detail has none', async () => {
      const details = defaultDetails();
      details[ID.r1] = { ...details[ID.r1], description: null };
      route({ details });
      const res = await service.scrape(input({ resultsWanted: 1 }));
      expect(res.jobs[0].description).toBeNull();
      expect(res.jobs[0].emails).toBeNull();
    });
  });

  describe('salary', () => {
    it('never reads a Brazilian-real amount as US dollars', async () => {
      route();
      const res = await service.scrape(input());
      const job = res.jobs.find((j) => j.atsId === ID.r3)!;
      expect(job.description).toContain('R$ 2.000,00');
      expect(job.compensation == null).toBe(true);
      expect(job.salarySource == null).toBe(true);
    });

    it('skips salary parsing when the text quotes R$ next to amounts the shared parser reads as USD', async () => {
      // The shared parser alone reads this as USD 5,000–7,000 a month.
      const details = defaultDetails();
      details[ID.r1] = { ...details[ID.r1], description: '<p>Faixa: R$5,000 - $7,000 per month</p>' };
      route({ details });
      const res = await service.scrape(input({ resultsWanted: 1 }));
      expect(res.jobs[0].compensation == null).toBe(true);
      expect(res.jobs[0].salarySource == null).toBe(true);
    });

    it('still parses a salary stated in another currency (control)', async () => {
      const details = defaultDetails();
      details[ID.r1] = { ...details[ID.r1], description: '<p>Salary: $80,000 - $100,000 per year</p>' };
      route({ details });
      const res = await service.scrape(input({ resultsWanted: 1 }));
      expect(res.jobs[0].compensation).toEqual(
        expect.objectContaining({
          minAmount: 80000,
          maxAmount: 100000,
          currency: 'USD',
          interval: CompensationInterval.YEARLY,
        }),
      );
      expect(res.jobs[0].salarySource).toBe('description');
    });
  });

  describe('filters', () => {
    it('pre-filters by title (accent-insensitive) before any detail request', async () => {
      route();
      const res = await service.scrape(input({ searchTerm: 'senior' }));
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1]);
      expect(detailIds()).toEqual([ID.r1]);
    });

    it('a search with no title match makes no detail request', async () => {
      route();
      const res = await service.scrape(input({ searchTerm: 'cozinheiro' }));
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
      expect(detailIds()).toEqual([]);
    });

    it('does not drop remote roles when isRemote is the default false', async () => {
      route();
      const res = await service.scrape(input({ isRemote: false }));
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2, ID.r3, ID.r5]);
    });

    it('keeps only remote roles when isRemote is true', async () => {
      route();
      const res = await service.scrape(input({ isRemote: true }));
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r5]);
    });

    it('drops roles older than hoursOld; a role without a date passes', async () => {
      const details = defaultDetails();
      details[ID.r2] = { ...details[ID.r2], publishedAt: null, createdAt: null, lastPublishedAt: null };
      route({ details });
      const res = await service.scrape(input({ hoursOld: 24 * 30 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2, ID.r3]);

      mockGet.mockClear();
      const narrow = await service.scrape(input({ hoursOld: 24 * 7 }));
      expect(narrow.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2]);
    });

    it('filters by location, accent-free, Brasil = Brazil', async () => {
      route();
      const curitiba = await service.scrape(input({ location: 'curitiba' }));
      expect(curitiba.jobs.map((j) => j.atsId)).toEqual([ID.r3]);

      const brasil = await service.scrape(input({ location: 'Brasil' }));
      expect(brasil.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2, ID.r3, ID.r5]);

      const saoPaulo = await service.scrape(input({ location: 'Sao Paulo, SP' }));
      expect(saoPaulo.jobs.map((j) => j.atsId)).toEqual([ID.r2]);
    });

    it('filters by jobType; a role with no mapped type passes', async () => {
      route();
      const res = await service.scrape(input({ jobType: JobType.INTERNSHIP }));
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r3, ID.r5]);
    });

    it('ignores country (the input DTO defaults it to USA)', async () => {
      route();
      const res = await service.scrape(input());
      expect(res.jobs).toHaveLength(4);
    });

    it('walks the list until enough roles match, then stops', async () => {
      route();
      const res = await service.scrape(input({ isRemote: true, resultsWanted: 1 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1]);
      expect(detailIds()).toEqual([ID.r1]);
    });
  });

  describe('paging and budget', () => {
    it('applies offset and resultsWanted in list order; detail requests equal offset + resultsWanted', async () => {
      route();
      const res = await service.scrape(input({ offset: 1, resultsWanted: 2 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r2, ID.r3]);
      expect(detailIds()).toEqual([ID.r1, ID.r2, ID.r3]);
    });

    it('fetches one more detail when a role in the window is closed', async () => {
      route();
      const res = await service.scrape(input({ resultsWanted: 4 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2, ID.r3, ID.r5]);
      expect(detailIds()).toEqual([ID.r1, ID.r2, ID.r3, ID.r4, ID.r5]);
    });

    it('returns nothing and makes no request when resultsWanted is 0', async () => {
      route();
      const res = await service.scrape(input({ resultsWanted: 0 }));
      expect(res.jobs).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    });

    it("'board' makes no detail request and emits list data only", async () => {
      route();
      const res = await service.scrape(input({ descriptionDepth: 'board', isRemote: true, location: 'Curitiba' }));
      expect(requestedUrls()).toEqual([LIST_URL]);
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2, ID.r3, ID.r4, ID.r5, ID.r6]);
      const job = res.jobs[4];
      expect(job.title).toBe('Pessoa Engenheira de Dados');
      expect(job.jobUrl).toBe(`https://acme-br.inhire.com.br/vagas/${ID.r5}`);
      expect(job.companyName).toBe('Acme Br');
      expect(job.companyUrl).toBe('https://acme-br.inhire.com.br/vagas');
      expect(job.description).toBeNull();
      expect(job.isRemote).toBeNull();
      expect(res.jobs[0].title).toBe('Desenvolvedor Backend Sênior');
    });

    it("'board' honours offset, resultsWanted and searchTerm", async () => {
      route();
      const res = await service.scrape(input({ descriptionDepth: 'board', offset: 1, resultsWanted: 2 }));
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r2, ID.r3]);
      const searched = await service.scrape(input({ descriptionDepth: 'board', searchTerm: 'dados' }));
      expect(searched.jobs.map((j) => j.atsId)).toEqual([ID.r2, ID.r5]);
    });

    it.each([
      ['detail-25', 25],
      [undefined, INHIRE_DEFAULT_DETAIL_BUDGET],
      ['detail-all', INHIRE_MAX_DETAIL_FETCHES],
    ] as const)('descriptionDepth %j caps detail requests at %i', async (depth, cap) => {
      const board = syntheticBoard(INHIRE_MAX_DETAIL_FETCHES + 20);
      route(board);
      const res = await service.scrape(input({ descriptionDepth: depth, resultsWanted: 1000 }));
      expect(detailIds()).toHaveLength(cap);
      expect(res.jobs).toHaveLength(cap);
      expect(res.diagnostics).toBeUndefined();
    });

    it('considers at most the first 500 list rows', async () => {
      const board = syntheticBoard(INHIRE_MAX_LIST_ITEMS + 25);
      route(board);
      const res = await service.scrape(input({ descriptionDepth: 'board', resultsWanted: 10_000 }));
      expect(res.jobs).toHaveLength(INHIRE_MAX_LIST_ITEMS);
    });
  });

  describe('degradation', () => {
    it.each([
      ['a 403', httpError(403, { message: 'Forbidden' }), 'blocked'],
      ['a network error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'fetch_error'],
      ['a timeout', new Error('timeout of 15000ms exceeded'), 'timeout'],
    ])('returns [] with a diagnostic when the list call fails with %s', async (_label, error, reason) => {
      route({ list: error });
      const res = await service.scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe(reason);
    });

    it('reports a {message} list body as fetch_error', async () => {
      route({ list: { message: 'Forbidden' } });
      const res = await service.scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toEqual(expect.objectContaining({ reason: 'fetch_error', detail: 'Forbidden' }));
      expect(detailIds()).toEqual([]);
    });

    it('reports a non-JSON list body as fetch_error', async () => {
      route({ list: '<html>maintenance</html>' });
      const res = await service.scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('parses a list body the client handed back as text', async () => {
      route({ list: JSON.stringify(fixture('list-acme.json')) });
      const res = await service.scrape(input({ descriptionDepth: 'board' }));
      expect(res.jobs).toHaveLength(6);
    });

    it('returns [] with no diagnostic for an empty board', async () => {
      route({ list: [] });
      const res = await service.scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeUndefined();
    });

    it('keeps the other jobs and adds a diagnostic when one detail fails (inferred partial)', async () => {
      route();
      const res = await service.scrape(input());
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2, ID.r3, ID.r5]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('skips a removed role (404) without a diagnostic', async () => {
      route({ missing: httpError(404, { message: 'Not Found' }) });
      const res = await service.scrape(input());
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2, ID.r3, ID.r5]);
      expect(res.diagnostics).toBeUndefined();
    });

    it('stops after three failed details in a row and returns [] with the failure', async () => {
      route({ details: {}, missing: httpError(502) });
      const res = await service.scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
      expect(detailIds()).toHaveLength(INHIRE_DETAIL_MAX_CONSECUTIVE_FAILURES);
    });

    it.each([
      [429, 'fetch_error'],
      [403, 'blocked'],
      [401, 'blocked'],
    ])('stops the detail walk at the first %p and makes no further detail call', async (status, reason) => {
      route({ details: { [ID.r1]: httpError(status) } });
      const res = await service.scrape(input());
      expect(detailIds()).toEqual([ID.r1]);
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics?.reason).toBe(reason);
    });

    it('returns the jobs collected before a refusal, with the refusal', async () => {
      const details: Record<string, unknown> = defaultDetails();
      details[ID.r3] = httpError(429);
      route({ details });
      const res = await service.scrape(input());
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2]);
      expect(detailIds()).toEqual([ID.r1, ID.r2, ID.r3]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('stops every worker of a two-worker pool on a refusal', async () => {
      process.env[INHIRE_DETAIL_CONCURRENCY_ENV] = '2';
      try {
        route({ details: {}, missing: httpError(403) });
        const res = await service.scrape(input());
        // Both workers had a call in flight when the first 403 landed; none after.
        expect(detailIds().length).toBeLessThanOrEqual(2);
        expect(res.diagnostics?.reason).toBe('blocked');
      } finally {
        delete process.env[INHIRE_DETAIL_CONCURRENCY_ENV];
      }
    });

    it('treats a challenge page in place of a detail as a refusal', async () => {
      route({ details: { [ID.r1]: '<html><title>Just a moment...</title></html>' } });
      const res = await service.scrape(input());
      expect(detailIds()).toEqual([ID.r1]);
      expect(res.diagnostics?.reason).toBe('blocked');
    });

    it('a success between failures resets the consecutive count', async () => {
      const details: Record<string, unknown> = defaultDetails();
      details[ID.r1] = httpError(500);
      details[ID.r2] = httpError(500);
      details[ID.r4] = httpError(500);
      details[ID.r5] = httpError(500);
      route({ details, missing: httpError(500) });
      const res = await service.scrape(input());
      // r1, r2 fail; r3 succeeds; r4, r5, r6 fail → stop after the third in a row.
      expect(detailIds()).toEqual([ID.r1, ID.r2, ID.r3, ID.r4, ID.r5, ID.r6]);
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r3]);
    });

    it('treats a detail for another role or a non-object body as a failure', async () => {
      const details = defaultDetails();
      details[ID.r1] = { ...details[ID.r1], jobId: ID.r2 };
      details[ID.r2] = 'not json' as unknown as Json;
      route({ details, missing: { ...fixture<Json>('detail-5.json'), jobId: ID.r6 } });
      const res = await service.scrape(input());
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r3, ID.r5, ID.r6]);
      expect(res.diagnostics?.reason).toBe('fetch_error');
    });

    it('never throws, even when the client itself throws synchronously', async () => {
      mockGet.mockImplementation(() => {
        throw new Error('boom');
      });
      const res = await service.scrape(input());
      expect(res.jobs).toEqual([]);
      expect(res.diagnostics).toBeDefined();
    });
  });

  describe('politeness', () => {
    /** Record start time and in-flight count; hold each request open for a macrotask. */
    function instrumented() {
      const starts: number[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const onRequest = async () => {
        starts.push(clock);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
      };
      return { starts, onRequest, max: () => maxInFlight };
    }

    const gaps = (starts: number[]) => starts.slice(1).map((t, i) => t - starts[i]);

    it('fetches details one at a time by default, paced 500 ms apart', async () => {
      const probe = instrumented();
      route({ onRequest: probe.onRequest });
      await service.scrape(input());
      expect(probe.starts).toHaveLength(7);
      expect(probe.max()).toBe(1);
      for (const gap of gaps(probe.starts)) expect(gap).toBeGreaterThanOrEqual(INHIRE_MIN_INTERVAL_MS);
    });

    it('allows at most two in flight with INHIRE_DETAIL_CONCURRENCY=2, still paced', async () => {
      process.env[INHIRE_DETAIL_CONCURRENCY_ENV] = '2';
      const probe = instrumented();
      route({ onRequest: probe.onRequest });
      const res = await service.scrape(input());
      expect(probe.max()).toBe(2);
      for (const gap of gaps(probe.starts)) expect(gap).toBeGreaterThanOrEqual(INHIRE_MIN_INTERVAL_MS);
      expect(res.jobs.map((j) => j.atsId)).toEqual([ID.r1, ID.r2, ID.r3, ID.r5]);
    });

    it('clamps INHIRE_DETAIL_CONCURRENCY to 2', async () => {
      process.env[INHIRE_DETAIL_CONCURRENCY_ENV] = '16';
      const probe = instrumented();
      route({ onRequest: probe.onRequest });
      await service.scrape(input());
      expect(probe.max()).toBeLessThanOrEqual(2);
    });

    it('lets INHIRE_MIN_INTERVAL_MS widen the gap but never narrow it', async () => {
      process.env[INHIRE_MIN_INTERVAL_ENV] = '1500';
      let probe = instrumented();
      route({ onRequest: probe.onRequest });
      await service.scrape(input({ resultsWanted: 2 }));
      for (const gap of gaps(probe.starts)) expect(gap).toBeGreaterThanOrEqual(1500);

      resetInhireState();
      process.env[INHIRE_MIN_INTERVAL_ENV] = '10';
      probe = instrumented();
      route({ onRequest: probe.onRequest });
      await service.scrape(input({ resultsWanted: 2 }));
      for (const gap of gaps(probe.starts)) expect(gap).toBeGreaterThanOrEqual(INHIRE_MIN_INTERVAL_MS);
    });

    it('paces two concurrent scrapes as one queue (one API host)', async () => {
      process.env[INHIRE_DETAIL_CONCURRENCY_ENV] = '2';
      const probe = instrumented();
      route({ onRequest: probe.onRequest });
      await Promise.all([
        service.scrape(input({ resultsWanted: 2 })),
        new InhireService().scrape(input({ companySlug: 'acme-br', resultsWanted: 2 })),
      ]);
      const sorted = [...probe.starts].sort((a, b) => a - b);
      expect(sorted.length).toBeGreaterThanOrEqual(6);
      for (const gap of gaps(sorted)) expect(gap).toBeGreaterThanOrEqual(INHIRE_MIN_INTERVAL_MS);
    });
  });
});
