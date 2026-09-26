import 'reflect-metadata';
import { readFileSync } from 'fs';
import { Logger } from '@nestjs/common';
import { join } from 'path';
import * as cheerio from 'cheerio';

const mockGet = jest.fn();
const mockSetHeaders = jest.fn();
const mockRandomSleep = jest.fn().mockResolvedValue(undefined);

jest.mock('@ever-jobs/common', () => ({
  ...(jest.requireActual('@ever-jobs/common') as object),
  createHttpClient: () => ({ get: mockGet, setHeaders: mockSetHeaders }),
  randomSleep: (...args: unknown[]) => mockRandomSleep(...args),
}));

import { POSTED_TIME_DETAIL_ENV } from '@ever-jobs/common';
import {
  CompensationInterval,
  DatePostedBasis,
  DatePostedPrecision,
  DescriptionFormat,
  JobType,
  ScraperInputDto,
} from '@ever-jobs/models';
import { LinkedInService } from '../src/linkedin.service';
import { LINKEDIN_FETCH_COMPANY_DETAILS_ENV, LINKEDIN_LEGACY_ENV } from '../src/linkedin.constants';
import type { LinkedInJobPost } from '../src/linkedin.types';

/**
 * Spec 1701 — LinkedIn guest scraper: pagination, identity, detail and company
 * enrichment, diagnostics; plus the Spec 1696 posted-time integration.
 */

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const PAGE_1 = fixture('search-page-10.html');
const PAGE_2 = fixture('search-page-10b.html');
const EMPTY = fixture('search-page-empty.html');
const FETCHED_AT = Date.parse('2026-09-24T20:00:03Z');
const SEARCH_PATH = '/jobs-guest/jobs/api/seeMoreJobPostings/search';

type Reply = string | Error | { status: number; data: string; request?: { res: { responseUrl: string } } };
type Route = Reply | ((url: string) => Reply);

function ok(data: string, url: string) {
  return { status: 200, data, request: { res: { responseUrl: url } } };
}

function httpError(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
}

function authwall(): Reply {
  return ok('<html><body>Sign in to see more</body></html>', 'https://www.linkedin.com/authwall?trk=bf&sessionRedirect=x');
}

function resolve(route: Route | undefined, url: string) {
  const reply = typeof route === 'function' ? route(url) : route;
  if (reply === undefined) throw new Error(`unexpected GET ${url}`);
  if (reply instanceof Error) throw reply;
  return typeof reply === 'string' ? ok(reply, url) : reply;
}

/** Search replies are consumed in order (then empty); detail and company replies are keyed by id / slug, `*` for any. */
function install(routes: { search?: Reply[]; detail?: Record<string, Route>; company?: Record<string, Route> } = {}) {
  const searchQueue = [...(routes.search ?? [])];
  mockGet.mockImplementation(async (url: string) => {
    if (url.includes(SEARCH_PATH)) return resolve(searchQueue.length > 0 ? searchQueue.shift() : EMPTY, url);
    const view = /\/jobs\/view\/(.+)$/.exec(url);
    if (view) return resolve(routes.detail?.[view[1]] ?? routes.detail?.['*'], url);
    const company = /\/company\/([^/?#]+)$/.exec(url);
    if (company) return resolve(routes.company?.[company[1]] ?? routes.company?.['*'], url);
    throw new Error(`unexpected GET ${url}`);
  });
}

const calls = (): Array<[string, { params?: Record<string, unknown> } | undefined]> =>
  mockGet.mock.calls as Array<[string, { params?: Record<string, unknown> } | undefined]>;
const searchCalls = () => calls().filter(([url]) => url.includes(SEARCH_PATH));
const searchStarts = () => searchCalls().map(([, config]) => config?.params?.start);
const detailUrls = () => calls().map(([url]) => url).filter((url) => url.includes('/jobs/view/'));
const companyUrls = () => calls().map(([url]) => url).filter((url) => url.includes('/company/'));

/** A search fragment made of the given cards of `search-page-10.html`. */
function pickCards(indexes: number[]): string {
  const $ = cheerio.load(PAGE_1);
  const items = $('li').has('.base-search-card');
  return indexes.map((i) => $.html(items.eq(i))).join('\n');
}

/** A synthetic card for company `slug`. */
function syntheticCard(n: number, slug: string): string {
  const id = String(1100000000 + n);
  return `<li><div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:${id}">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/role-${n}-at-${slug}-${id}?position=${n}"></a>
    <h3 class="base-search-card__title">Role ${n}</h3>
    <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/${slug}?trk=x">Company ${n}</a></h4>
    <span class="job-search-card__location">Portland, OR</span>
    <time class="job-search-card__listdate" datetime="2026-09-20">4 days ago</time></div></li>`;
}

function detailPage(options: { ld?: string; description?: boolean }): string {
  const ld = options.ld
    ? `<script type="application/ld+json">${JSON.stringify({
        '@context': 'http://schema.org',
        '@type': 'JobPosting',
        title: 'Synthetic role',
        datePosted: options.ld,
      })}</script>`
    : '';
  const body = options.description === false ? '' : '<div class="show-more-less-html__markup"><p>Synthetic body</p></div>';
  return `<html><head>${ld}</head><body><div class="decorated-job-posting__details">${body}</div></body></html>`;
}

function input(overrides: Partial<ScraperInputDto> & { linkedinFetchCompanyDetails?: boolean } = {}): ScraperInputDto {
  return new ScraperInputDto({ searchTerm: 'engineer', location: 'United States', resultsWanted: 50, ...overrides } as never);
}

async function scrape(overrides: Parameters<typeof input>[0] = {}) {
  const result = await new LinkedInService().scrape(input(overrides));
  return { ...result, jobs: result.jobs as LinkedInJobPost[] };
}

const ENV_KEYS = [LINKEDIN_LEGACY_ENV, LINKEDIN_FETCH_COMPANY_DETAILS_ENV, POSTED_TIME_DETAIL_ENV];
let savedEnv: Record<string, string | undefined>;

beforeAll(() => {
  Logger.overrideLogger(false);
});

beforeEach(() => {
  jest.clearAllMocks();
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  jest.spyOn(Date, 'now').mockReturnValue(FETCHED_AT);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
});

describe('LinkedInService pagination (Spec 1701 A/B)', () => {
  it('advances start by the cards on the page (0, 10, 20 — not 25)', async () => {
    install({ search: [PAGE_1, PAGE_2, EMPTY] });
    const { jobs, diagnostics } = await scrape({ resultsWanted: 20 });
    expect(searchStarts()).toEqual([0, 10, 20]);
    // page 1: 9 usable cards (one has no id); page 2: 8 new (2 repeat page 1)
    expect(jobs).toHaveLength(17);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(17);
    expect(diagnostics).toBeUndefined();
  });

  it('starts at the offset', async () => {
    install({ search: [PAGE_1, EMPTY] });
    await scrape({ offset: 30 });
    expect(searchStarts()).toEqual([30, 40]);
  });

  it('an empty page stops the loop', async () => {
    install({ search: [PAGE_1, EMPTY] });
    const { jobs } = await scrape();
    expect(searchStarts()).toEqual([0, 10]);
    expect(jobs).toHaveLength(9);
  });

  it('two consecutive all-duplicate pages stop the loop', async () => {
    install({ search: [PAGE_1, PAGE_1, PAGE_1, PAGE_1, PAGE_1] });
    const { jobs } = await scrape();
    expect(searchStarts()).toEqual([0, 10, 20]);
    expect(jobs).toHaveLength(9);
  });

  it('one all-duplicate page between new ones does not stop it', async () => {
    install({ search: [PAGE_1, PAGE_1, PAGE_2, EMPTY] });
    const { jobs } = await scrape();
    expect(searchStarts()).toEqual([0, 10, 20, 30]);
    expect(jobs).toHaveLength(17);
  });

  it('never requests start=1000', async () => {
    install({ search: [PAGE_1, PAGE_2, PAGE_2] });
    await scrape({ offset: 990 });
    expect(searchStarts()).toEqual([990]);
  });

  it('stops at resultsWanted without another request', async () => {
    install({ search: [PAGE_1, PAGE_2] });
    const { jobs } = await scrape({ resultsWanted: 5 });
    expect(jobs).toHaveLength(5);
    expect(searchStarts()).toEqual([0]);
  });

  it('paces every request after the first, sequentially', async () => {
    install({ search: [PAGE_1, PAGE_2, EMPTY] });
    await scrape();
    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(mockRandomSleep).toHaveBeenCalledTimes(2);
    expect(mockRandomSleep).toHaveBeenCalledWith(3000, 7000);
  });

  it('EVER_JOBS_LINKEDIN_LEGACY=pagination keeps the 25 step and the first-duplicate-page stop', async () => {
    process.env[LINKEDIN_LEGACY_ENV] = 'pagination';
    install({ search: [PAGE_1, PAGE_2, EMPTY] });
    await scrape();
    expect(searchStarts()).toEqual([0, 25, 50]);

    mockGet.mockReset();
    install({ search: [PAGE_1, PAGE_1, PAGE_1] });
    await scrape();
    expect(searchStarts()).toEqual([0, 25]);
  });
});

describe('LinkedInService search parameters', () => {
  it('sends the filters it always sent, with f_WT=2 for remote', async () => {
    install({ search: [EMPTY] });
    await scrape({ isRemote: true, easyApply: true, hoursOld: 24, linkedinCompanyIds: [1, 2], jobType: JobType.CONTRACT });
    expect(searchCalls()[0][0]).toBe(`https://www.linkedin.com${SEARCH_PATH}`);
    expect(searchCalls()[0][1]?.params).toEqual({
      keywords: 'engineer',
      location: 'United States',
      distance: 50,
      start: 0,
      sortBy: 'DD',
      f_AL: 'true',
      f_JT: 'C',
      f_WT: '2',
      f_TPR: 'r86400',
      f_C: '1,2',
    });
    expect(mockSetHeaders).toHaveBeenCalledTimes(1);
  });
});

describe('LinkedInService identity and card fields (Spec 1701 D-I)', () => {
  it('uses numeric ids, canonical job URLs and normalised company URLs', async () => {
    install({ search: [PAGE_1] });
    const { jobs } = await scrape();
    expect(jobs[0].id).toBe('li-1000000001');
    expect(jobs[0].jobUrl).toBe('https://www.linkedin.com/jobs/view/1000000001');
    expect(jobs[0].companyUrl).toBe('https://www.linkedin.com/company/acme-robotics');
    expect(jobs.map((j) => j.id)).toContain('li-1000000005'); // id from the href
    expect(jobs.every((j) => /^li-\d+$/.test(j.id!))).toBe(true);
    expect(jobs.every((j) => !j.companyUrl!.includes('?'))).toBe(true);
  });

  it('EVER_JOBS_LINKEDIN_LEGACY=ids keeps slug ids and URLs', async () => {
    process.env[LINKEDIN_LEGACY_ENV] = 'ids';
    install({ search: [PAGE_1] });
    const { jobs } = await scrape();
    expect(jobs[0].id).toBe('li-senior-robotics-engineer-%E2%80%93-controls-at-acme-robotics-1000000001');
    expect(jobs[0].companyUrl).toContain('?trk=');
    expect(jobs).toHaveLength(10);
  });

  it('stamps isRemote and workFromHomeType on every job when remote was requested', async () => {
    install({ search: [PAGE_1] });
    const { jobs } = await scrape({ isRemote: true });
    expect(jobs.every((j) => j.isRemote === true && j.workFromHomeType === 'Remote')).toBe(true);
  });

  it('without the filter only real remote signals count', async () => {
    install({ search: [PAGE_1] });
    const { jobs } = await scrape();
    const byId = new Map(jobs.map((j) => [j.id, j]));
    expect(byId.get('li-1000000001')!.isRemote).toBe(false); // Seattle, WA
    expect(byId.get('li-1000000003')!.isRemote).toBe(false); // Remote Sensing Analyst
    expect(byId.get('li-1000000006')!.isRemote).toBe(true); // location "Remote"
  });

  it('parses the card pay and logo', async () => {
    install({ search: [PAGE_1] });
    const { jobs } = await scrape();
    expect(jobs[1].compensation).toMatchObject({ minAmount: 53000, maxAmount: 65000, currency: 'USD', interval: 'yearly' });
    expect(jobs[0].companyLogo).toMatch(/^https:\/\/media\.licdn\.com\//);
    expect(jobs[2].companyLogo).toBeUndefined();
  });
});

describe('LinkedInService diagnostics (Spec 1701 §7)', () => {
  it('a 999 on page 1 is blocked, with no jobs', async () => {
    install({ search: [httpError(999)] });
    const { jobs, diagnostics } = await scrape();
    expect(jobs).toEqual([]);
    expect(diagnostics?.reason).toBe('blocked');
    expect(diagnostics?.detail).toContain('start=0');
  });

  it('an authwall served as a 200 is blocked, not empty', async () => {
    install({ search: [authwall()] });
    const { jobs, diagnostics } = await scrape();
    expect(jobs).toEqual([]);
    expect(diagnostics?.reason).toBe('blocked');
  });

  it('a 429 on page 2 keeps page 1 and reports fetch_error', async () => {
    install({ search: [PAGE_1, httpError(429)] });
    const { jobs, diagnostics } = await scrape();
    expect(jobs).toHaveLength(9);
    expect(diagnostics?.reason).toBe('fetch_error');
  });

  it('a network error is classified, never swallowed', async () => {
    install({ search: [Object.assign(new Error('getaddrinfo ENOTFOUND www.linkedin.com'), { code: 'ENOTFOUND' })] });
    const { diagnostics } = await scrape();
    expect(diagnostics?.reason).toBe('fetch_error');
  });

  it('an empty board has no diagnostics', async () => {
    install({ search: [EMPTY] });
    const { jobs, diagnostics } = await scrape();
    expect(jobs).toEqual([]);
    expect(diagnostics).toBeUndefined();
  });
});

describe('LinkedInService detail pages (Spec 1701 J/K/L)', () => {
  const twoJobs = () => pickCards([0, 1]);

  it('merges the detail fields; detail pay overrides the card, similar-jobs pay is ignored', async () => {
    install({
      search: [twoJobs()],
      detail: { '1000000001': fixture('job-view.html'), '1000000002': fixture('job-view-with-pay.html') },
    });
    const { jobs, diagnostics } = await scrape({
      resultsWanted: 2,
      linkedinFetchDescription: true,
      descriptionFormat: DescriptionFormat.MARKDOWN,
    });
    expect(detailUrls()).toEqual([
      'https://www.linkedin.com/jobs/view/1000000001',
      'https://www.linkedin.com/jobs/view/1000000002',
    ]);
    expect(diagnostics).toBeUndefined();

    const [intern, data] = jobs;
    expect(intern.description).toContain('warehouse robots');
    expect(intern.description).not.toMatch(/Show more|Show less/);
    expect(intern.emails).toEqual(['jobs@acme-robotics.example']);
    expect(intern.jobType).toEqual([JobType.FULL_TIME]);
    expect(intern.jobLevel).toBe('Internship');
    expect(intern.jobFunction).toBe('Other');
    expect(intern.companyIndustry).toBe('Robotics Engineering');
    expect(intern.companySourceId).toBe('12345');
    expect(intern.applicantsCount).toBe(25);
    expect(intern.applicantsCountBound).toBe('max');
    expect(intern.compensation).toBeNull();

    expect(data.compensation).toMatchObject({
      minAmount: 155000,
      maxAmount: 160000,
      currency: 'USD',
      interval: CompensationInterval.YEARLY,
    });
    expect(data.applicantsCount).toBe(200);
    expect(data.applicantsCountBound).toBe('min');
    expect('companySourceId' in data).toBe(false);
    expect(data.jobUrlDirect).toBe('https://careers.globex.example/jobs/42');
    expect(data.jobType).toEqual([JobType.CONTRACT]);
  });

  it('keeps the card logo and fills a missing one from the top card', async () => {
    install({ search: [pickCards([0, 2])], detail: { '*': fixture('job-view.html') } });
    const { jobs } = await scrape({ resultsWanted: 2, linkedinFetchDescription: true });
    expect(jobs[0].companyLogo).toContain('FAKE1');
    expect(jobs[1].companyLogo).toContain('FAKETOP1');
  });

  it('a failed detail page keeps the card-only job; the first error is reported', async () => {
    install({ search: [twoJobs()], detail: { '1000000001': httpError(500), '1000000002': httpError(404) } });
    const { jobs, diagnostics } = await scrape({ resultsWanted: 2, linkedinFetchDescription: true });
    expect(jobs).toHaveLength(2);
    expect(jobs[1].compensation).toMatchObject({ minAmount: 53000 });
    expect(jobs[0].description).toBeUndefined();
    expect(detailUrls()).toHaveLength(2);
    expect(diagnostics?.reason).toBe('fetch_error');
  });

  it('a blocked detail page stops the remaining detail fetches', async () => {
    install({ search: [twoJobs()], detail: { '*': httpError(999) } });
    const { jobs, diagnostics } = await scrape({ resultsWanted: 2, linkedinFetchDescription: true });
    expect(detailUrls()).toHaveLength(1);
    expect(jobs).toHaveLength(2);
    expect(diagnostics?.reason).toBe('blocked');
  });

  it('an authwall detail page also stops them', async () => {
    install({ search: [twoJobs()], detail: { '*': authwall() } });
    const { diagnostics } = await scrape({ resultsWanted: 2, linkedinFetchDescription: true });
    expect(detailUrls()).toHaveLength(1);
    expect(diagnostics?.reason).toBe('blocked');
  });

  it('a search diagnostic is not replaced by a later detail one', async () => {
    install({ search: [PAGE_1, httpError(429)], detail: { '*': httpError(500) } });
    const { diagnostics } = await scrape({ resultsWanted: 10, linkedinFetchDescription: true });
    expect(diagnostics?.reason).toBe('fetch_error');
    expect(diagnostics?.detail).toContain('429');
  });

  it('EVER_JOBS_LINKEDIN_LEGACY=detail keeps the old description and job type reads', async () => {
    process.env[LINKEDIN_LEGACY_ENV] = 'detail';
    install({ search: [pickCards([0])], detail: { '*': fixture('job-view.html') } });
    const { jobs } = await scrape({ resultsWanted: 1, linkedinFetchDescription: true });
    expect(jobs[0].description).toMatch(/Show more/);
    expect(jobs[0].jobType).toEqual(expect.arrayContaining([JobType.INTERNSHIP]));
  });

  it('no detail fetch without linkedinFetchDescription', async () => {
    install({ search: [PAGE_1] });
    await scrape();
    expect(detailUrls()).toEqual([]);
  });
});

describe('LinkedInService posted time (Spec 1696 integration)', () => {
  const CARDS = fixture('linkedin-search-cards.html');

  it('refines sub-day cards to an instant and leaves datePosted as the attribute', async () => {
    install({ search: [CARDS, EMPTY] });
    const { jobs } = await scrape({ resultsWanted: 10 });
    expect(jobs).toHaveLength(7);
    const [minutes, hour, days, week, localised, inconsistent, none] = jobs;

    expect(minutes).toMatchObject({
      datePosted: '2026-09-24',
      datePostedAt: '2026-09-24T19:34:00.000Z',
      datePostedPrecision: DatePostedPrecision.MINUTE,
      datePostedBasis: DatePostedBasis.RELATIVE,
    });
    expect(hour).toMatchObject({ datePostedAt: '2026-09-24T19:00:00.000Z', datePostedPrecision: DatePostedPrecision.HOUR });
    for (const [job, date] of [
      [days, '2026-09-22'],
      [week, '2026-09-12'],
      [localised, '2026-09-24'],
      [inconsistent, '2026-09-20'],
    ] as const) {
      expect(job.datePosted).toBe(date);
      expect(job.datePostedPrecision).toBe(DatePostedPrecision.DAY);
      expect(job.datePostedBasis).toBe(DatePostedBasis.DATE);
      expect('datePostedAt' in job).toBe(false);
    }
    expect(none.datePosted).toBeNull();
    expect('datePostedPrecision' in none).toBe(false);
  });

  it('logs one posted-time counter line per scrape', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug');
    install({ search: [CARDS, EMPTY] });
    await scrape({ resultsWanted: 10 });
    expect(debug).toHaveBeenCalledWith('posted-time: 2 relative, 4 date-only, 1 none, 0 upgraded from JSON-LD');
  });

  it('EVER_JOBS_POSTED_TIME_DETAIL=false keeps the pre-1696 shape', async () => {
    process.env[POSTED_TIME_DETAIL_ENV] = 'false';
    install({ search: [CARDS, EMPTY] });
    const { jobs } = await scrape({ resultsWanted: 10 });
    expect(jobs[0].datePosted).toBe('2026-09-24');
    expect(jobs.some((j) => 'datePostedAt' in j || 'datePostedPrecision' in j)).toBe(false);
  });

  it('upgrades to the JSON-LD instant when it agrees with the card date', async () => {
    install({
      search: [CARDS, EMPTY],
      detail: {
        '9000000001': detailPage({ ld: '2026-09-24T19:34:25.000Z' }),
        '9000000002': detailPage({}),
      },
    });
    const { jobs } = await scrape({ resultsWanted: 2, linkedinFetchDescription: true });
    expect(jobs[0]).toMatchObject({
      datePosted: '2026-09-24',
      datePostedAt: '2026-09-24T19:34:25.000Z',
      datePostedPrecision: DatePostedPrecision.EXACT,
      datePostedBasis: DatePostedBasis.TIMESTAMP,
    });
    expect(jobs[1]).toMatchObject({
      datePostedAt: '2026-09-24T19:00:00.000Z',
      datePostedPrecision: DatePostedPrecision.HOUR,
      datePostedBasis: DatePostedBasis.RELATIVE,
    });
  });

  it('rejects a JSON-LD instant 5 days from the card date', async () => {
    install({ search: [CARDS, EMPTY], detail: { '*': detailPage({ ld: '2026-09-19T10:00:00.000Z' }) } });
    const { jobs } = await scrape({ resultsWanted: 1, linkedinFetchDescription: true });
    expect(jobs[0]).toMatchObject({ datePostedAt: '2026-09-24T19:34:00.000Z', datePostedPrecision: DatePostedPrecision.MINUTE });
  });

  it('upgrades the time even when the page has no description block', async () => {
    install({ search: [CARDS, EMPTY], detail: { '*': detailPage({ ld: '2026-09-24T19:34:25Z', description: false }) } });
    const { jobs } = await scrape({ resultsWanted: 1, linkedinFetchDescription: true });
    expect(jobs[0].datePostedAt).toBe('2026-09-24T19:34:25.000Z');
    expect(jobs[0].description).toBeUndefined();
  });

  it('fills the date of a card that had none, never overwrites one', async () => {
    const noTime = cheerio.load(CARDS);
    const lastCard = $html(noTime, 6);
    install({ search: [lastCard, EMPTY], detail: { '*': detailPage({ ld: '2026-09-23T08:00:00Z' }) } });
    const { jobs } = await scrape({ resultsWanted: 1, linkedinFetchDescription: true });
    expect(jobs[0]).toMatchObject({
      datePosted: '2026-09-23',
      datePostedAt: '2026-09-23T08:00:00.000Z',
      datePostedPrecision: DatePostedPrecision.EXACT,
    });
  });
});

function $html($: cheerio.CheerioAPI, index: number): string {
  return $.html($('li').has('.base-search-card').eq(index));
}

describe('LinkedInService company enrichment (Spec 1701 §5.7)', () => {
  it('is off by default: no company requests', async () => {
    install({ search: [PAGE_1] });
    await scrape();
    expect(companyUrls()).toEqual([]);
  });

  it('fetches each company once and fills only empty fields', async () => {
    install({
      search: [pickCards([0, 1, 7])],
      company: { 'acme-robotics': fixture('company-page.html'), globex: fixture('company-page-dom-only.html') },
    });
    const { jobs, diagnostics } = await scrape({ linkedinFetchCompanyDetails: true });
    expect(companyUrls()).toEqual([
      'https://www.linkedin.com/company/acme-robotics',
      'https://www.linkedin.com/company/globex',
    ]);
    expect(diagnostics).toBeUndefined();

    const [acme, globex, acmeAgain] = jobs;
    expect(acme).toMatchObject({
      companyUrlDirect: 'http://acme.example',
      companyNumEmployees: '1,001-5,000',
      companyAddresses: '100 Example Way, Seattle, WA 98101, US',
      companyIndustry: 'Robotics Engineering',
      companyDescription: 'Acme Robotics builds warehouse robots.',
    });
    expect(acme.companyLogo).toContain('FAKE1'); // the card logo is kept
    expect(acmeAgain.companyUrlDirect).toBe('http://acme.example');
    expect(globex).toMatchObject({
      companyUrlDirect: 'https://www.globex.example/',
      companyNumEmployees: '51-200',
      companyAddresses: 'Warren, MI',
    });
  });

  it('never overwrites an industry the detail page set', async () => {
    install({
      search: [pickCards([0])],
      detail: { '*': fixture('job-view.html') },
      company: { '*': fixture('company-page-dom-only.html') },
    });
    const { jobs } = await scrape({ resultsWanted: 1, linkedinFetchDescription: true, linkedinFetchCompanyDetails: true });
    expect(jobs[0].companyIndustry).toBe('Robotics Engineering');
    expect(jobs[0].companyNumEmployees).toBe('51-200');
  });

  it('caches a failed company page (one request) and leaves the fields empty', async () => {
    install({ search: [pickCards([0, 7])], company: { '*': httpError(500) } });
    const { jobs, diagnostics } = await scrape({ linkedinFetchCompanyDetails: true });
    expect(companyUrls()).toHaveLength(1);
    expect(jobs.every((j) => j.companyUrlDirect === undefined)).toBe(true);
    expect(diagnostics).toBeUndefined();
  });

  it.each([
    ['a 999', httpError(999)],
    ['an authwall', authwall()],
  ])('%s on the first company page stops all company requests, without diagnostics', async (_, reply) => {
    install({ search: [pickCards([0, 1, 3])], company: { '*': reply } });
    const { jobs, diagnostics } = await scrape({ linkedinFetchCompanyDetails: true });
    expect(companyUrls()).toHaveLength(1);
    expect(jobs).toHaveLength(3);
    expect(diagnostics).toBeUndefined();
  });

  it('caps company pages at 25 per call', async () => {
    const cards = Array.from({ length: 30 }, (_, i) => syntheticCard(i + 1, `company-${i + 1}`)).join('\n');
    install({ search: [cards], company: { '*': fixture('company-page-dom-only.html') } });
    const { jobs } = await scrape({ linkedinFetchCompanyDetails: true });
    expect(jobs).toHaveLength(30);
    expect(companyUrls()).toHaveLength(25);
    expect(jobs[24].companyNumEmployees).toBe('51-200');
    expect(jobs[25].companyNumEmployees).toBeUndefined();
  });

  it('EVER_JOBS_LINKEDIN_FETCH_COMPANY_DETAILS turns it on when the input is silent', async () => {
    process.env[LINKEDIN_FETCH_COMPANY_DETAILS_ENV] = 'true';
    install({ search: [pickCards([0])], company: { '*': fixture('company-page.html') } });
    await scrape();
    expect(companyUrls()).toHaveLength(1);
  });

  it('paces company requests like every other request', async () => {
    install({ search: [pickCards([0, 1])], company: { '*': fixture('company-page.html') } });
    await scrape({ linkedinFetchCompanyDetails: true });
    // 2 search pages (cards, then the default empty page) + 2 company pages
    expect(mockGet).toHaveBeenCalledTimes(4);
    expect(mockRandomSleep).toHaveBeenCalledTimes(3);
  });
});
