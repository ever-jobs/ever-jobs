import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockSetHeaders = jest.fn();

jest.mock('@ever-jobs/common', () => ({
  ...(jest.requireActual('@ever-jobs/common') as object),
  createHttpClient: () => ({ get: mockGet, post: mockPost, setHeaders: mockSetHeaders }),
  randomSleep: jest.fn().mockResolvedValue(undefined),
}));

import { Country, DescriptionFormat, ScraperInputDto } from '@ever-jobs/models';
import { toDateOnly } from '@ever-jobs/common';
import { GlassdoorService } from '../src/glassdoor.service';
import {
  FALLBACK_CSRF_TOKEN,
  GLASSDOOR_HEADERS,
  GLASSDOOR_LEGACY_ENV,
  GLASSDOOR_MAX_PAGES_ENV,
  NO_CSRF_TOKEN_NOTE,
} from '../src/glassdoor.constants';

/**
 * Spec 1703: the service against mocked HTTP. Every scenario counts the
 * requests it makes, because the defects fixed here were about requests: a
 * search sent after a challenge, and a pagination loop with no end.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const fixtureText = (name: string): string => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
/** A fresh deep copy each call, so a test can mutate it freely. */
const fixtureJson = (name: string): any => JSON.parse(fixtureText(name));

const CHALLENGE_HTML = fixtureText('challenge.html');
const HOME_WITH_TOKEN_HTML = fixtureText('home-with-token.html');
const SITE_TOKEN = 'AbCdEf012345_-xyz:QwErTy987654_-abc:ZxCvBn456';

const ok = (data: unknown, headers: Record<string, string> = {}) => ({ status: 200, data, headers });

function httpError(status: number, data: unknown, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data, headers },
  });
}

/** A listing with the given id and location, in the search response's shape. */
function listing(id: number, locationName = 'Austin, TX', extra: Record<string, unknown> = {}) {
  return {
    jobview: {
      header: {
        adOrderId: 9000 + id,
        ageInDays: 1,
        employerNameFromSearch: `Employer ${id}`,
        jobLink: `/partner/jobListing.htm?jl=${id}`,
        jobTitleText: `Job ${id}`,
        locId: 1,
        locationName,
        locationType: 'C',
        ...extra,
      },
      job: { descriptionFragments: [`<p>Role ${id}</p>`], listingId: id },
      overview: { shortName: `Employer ${id}` },
    },
  };
}

function page(listings: unknown[], cursors: Array<{ cursor: string; pageNumber: number }>) {
  return { data: { jobListings: { jobListings: listings, paginationCursors: cursors } } };
}

const input = (extra: Partial<ScraperInputDto> = {}) =>
  new ScraperInputDto({ searchTerm: 'software engineer', ...extra } as never);

const postHeaders = (call = 0): Record<string, string> => mockPost.mock.calls[call][2].headers;

describe('GlassdoorService (Spec 1703)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[GLASSDOOR_LEGACY_ENV];
    delete process.env[GLASSDOOR_MAX_PAGES_ENV];
  });

  afterAll(() => {
    delete process.env[GLASSDOOR_LEGACY_ENV];
    delete process.env[GLASSDOOR_MAX_PAGES_ENV];
  });

  describe('A1: fail fast on a challenge', () => {
    it('a 403 challenge on the homepage reports blocked and never calls the search', async () => {
      mockGet.mockRejectedValue(httpError(403, CHALLENGE_HTML, { 'cf-mitigated': 'challenge' }));

      const result = await new GlassdoorService().scrape(input());

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('blocked');
      expect(result.diagnostics?.detail).toBe('homepage challenge (HTTP 403, cf-mitigated: challenge)');
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('a challenge page served with 200 is treated the same way', async () => {
      mockGet.mockResolvedValue(ok(CHALLENGE_HTML));

      const result = await new GlassdoorService().scrape(input());

      expect(result.diagnostics?.reason).toBe('blocked');
      expect(result.diagnostics?.detail).toBe('homepage challenge (HTTP 200)');
      expect(mockPost).not.toHaveBeenCalled();
    });

    it('the challenge legacy mode still sends the search (old behaviour reachable)', async () => {
      process.env[GLASSDOOR_LEGACY_ENV] = 'challenge';
      mockGet.mockRejectedValue(httpError(403, CHALLENGE_HTML, { 'cf-mitigated': 'challenge' }));
      mockPost.mockRejectedValue(httpError(403, 'Forbidden'));

      const result = await new GlassdoorService().scrape(input());

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(postHeaders()['gd-csrf-token']).toBe(FALLBACK_CSRF_TOKEN);
      expect(result.diagnostics?.reason).toBe('blocked');
    });

    it('a non-challenge homepage failure keeps going with the fallback token', async () => {
      mockGet.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      mockPost.mockResolvedValueOnce(ok(fixtureJson('graph-page1.json')));

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 3 }));

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(postHeaders()['gd-csrf-token']).toBe(FALLBACK_CSRF_TOKEN);
      expect(result.jobs).toHaveLength(3);
      expect(result.diagnostics).toBeUndefined();
    });

    it('a challenge on the search itself reports blocked with its own detail', async () => {
      mockGet.mockResolvedValue(ok(HOME_WITH_TOKEN_HTML));
      mockPost.mockRejectedValue(httpError(403, CHALLENGE_HTML, { 'cf-mitigated': 'challenge' }));

      const result = await new GlassdoorService().scrape(input());

      expect(result.diagnostics?.reason).toBe('blocked');
      expect(result.diagnostics?.detail).toBe('search challenge (HTTP 403, cf-mitigated: challenge)');
    });
  });

  describe('A8: CSRF token', () => {
    it('sends the site token found on the homepage', async () => {
      mockGet.mockResolvedValue(ok(HOME_WITH_TOKEN_HTML));
      mockPost.mockResolvedValueOnce(ok(fixtureJson('graph-page1.json')));

      await new GlassdoorService().scrape(input({ resultsWanted: 3 }));

      expect(postHeaders()['gd-csrf-token']).toBe(SITE_TOKEN);
    });

    it('sends a legacy gdCSRF token', async () => {
      mockGet.mockResolvedValue(ok('<html><script>var gdCSRF = "tok";</script></html>'));
      mockPost.mockResolvedValueOnce(ok(fixtureJson('graph-page1.json')));

      await new GlassdoorService().scrape(input({ resultsWanted: 3 }));

      expect(postHeaders()['gd-csrf-token']).toBe('tok');
    });

    it('notes a missing token in later diagnostics', async () => {
      mockGet.mockResolvedValue(ok('<html>no token here</html>'));
      mockPost.mockRejectedValue(httpError(403, 'Forbidden'));

      const result = await new GlassdoorService().scrape(input());

      expect(postHeaders()['gd-csrf-token']).toBe(FALLBACK_CSRF_TOKEN);
      expect(result.diagnostics?.reason).toBe('blocked');
      expect(result.diagnostics?.detail).toBe(`Request failed with status code 403 ${NO_CSRF_TOKEN_NOTE}`);
    });

    it('does not add the note when a token was extracted', async () => {
      mockGet.mockResolvedValue(ok(HOME_WITH_TOKEN_HTML));
      mockPost.mockRejectedValue(httpError(403, 'Forbidden'));

      const result = await new GlassdoorService().scrape(input());

      expect(result.diagnostics?.detail).toBe('Request failed with status code 403');
    });
  });

  describe('A2: GraphQL errors are surfaced, never a silent zero', () => {
    beforeEach(() => mockGet.mockResolvedValue(ok(HOME_WITH_TOKEN_HTML)));

    it('errors with no data -> fetch_error carrying the message', async () => {
      mockPost.mockResolvedValueOnce(ok(fixtureJson('graph-errors-only.json')));

      const result = await new GlassdoorService().scrape(input());

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(result.diagnostics?.detail).toContain('FilterParamInput');
      expect(result.diagnostics?.detail?.startsWith('graphql: ')).toBe(true);
    });

    it('non-fatal errors next to data -> rows parsed, no diagnostics (batched body)', async () => {
      mockPost.mockResolvedValueOnce(ok(fixtureJson('graph-errors-with-data.json')));

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 1 }));

      expect(result.jobs.map((j) => j.id)).toEqual(['gd-2001']);
      expect(result.diagnostics).toBeUndefined();
    });

    it('neither data nor errors -> unknown / graphql: empty body', async () => {
      mockPost.mockResolvedValueOnce(ok({}));

      const result = await new GlassdoorService().scrape(input());

      expect(result.diagnostics?.reason).toBe('unknown');
      expect(result.diagnostics?.detail).toBe('graphql: empty body');
    });

    it('an HTML body -> unknown / graphql: non-JSON body', async () => {
      mockPost.mockResolvedValueOnce(ok('<html>maintenance</html>'));

      const result = await new GlassdoorService().scrape(input());

      expect(result.diagnostics?.reason).toBe('unknown');
      expect(result.diagnostics?.detail).toBe('graphql: non-JSON body');
    });

    it('a 200 challenge body on the search -> blocked', async () => {
      mockPost.mockResolvedValueOnce(ok(CHALLENGE_HTML));

      const result = await new GlassdoorService().scrape(input());

      expect(result.diagnostics?.reason).toBe('blocked');
      expect(result.diagnostics?.detail).toBe('search challenge (HTTP 200)');
    });

    it('rows from earlier pages are kept when a later page fails', async () => {
      mockPost
        .mockResolvedValueOnce(ok(page([listing(1), listing(2)], [{ cursor: 'c2', pageNumber: 2 }])))
        .mockResolvedValueOnce(ok(fixtureJson('graph-errors-only.json')));

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10 }));

      expect(result.jobs.map((j) => j.id)).toEqual(['gd-1', 'gd-2']);
      expect(result.diagnostics?.reason).toBe('fetch_error');
      expect(mockPost).toHaveBeenCalledTimes(2);
    });
  });

  describe('A3: bounded pagination', () => {
    beforeEach(() => mockGet.mockResolvedValue(ok(HOME_WITH_TOKEN_HTML)));

    it('stops when there is no cursor for the next page (the unbounded-loop regression)', async () => {
      mockPost.mockResolvedValue(ok(fixtureJson('graph-page1.json')));

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 100 }));

      expect(mockPost.mock.calls.length).toBeLessThanOrEqual(2);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(result.jobs).toHaveLength(3);
    });

    it('stops when a page adds no new ids', async () => {
      const first = page([listing(1), listing(2)], [{ cursor: 'c2', pageNumber: 2 }]);
      const repeat = page([listing(1), listing(2)], [{ cursor: 'c3', pageNumber: 3 }]);
      mockPost.mockResolvedValueOnce(ok(first)).mockResolvedValue(ok(repeat));

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 100 }));

      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(result.jobs).toHaveLength(2);
      expect(mockPost.mock.calls[1][1].variables.pageCursor).toBe('c2');
    });

    it('never requests more than ceil((offset + resultsWanted) / 30) + 1 pages', async () => {
      let next = 1;
      mockPost.mockImplementation(async () => {
        const n = next++;
        return ok(page([listing(n * 10 + 1), listing(n * 10 + 2)], [{ cursor: `c${n + 1}`, pageNumber: n + 1 }]));
      });

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 40 }));

      // ceil(40 / 30) + 1 = 3 pages, even though every page offers a next cursor.
      expect(mockPost).toHaveBeenCalledTimes(3);
      expect(result.jobs).toHaveLength(6);
    });

    it('the page cap env var bounds the run further', async () => {
      process.env[GLASSDOOR_MAX_PAGES_ENV] = '2';
      let next = 1;
      mockPost.mockImplementation(async () => {
        const n = next++;
        return ok(page([listing(n)], [{ cursor: `c${n + 1}`, pageNumber: n + 1 }]));
      });

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 500 }));

      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(result.jobs).toHaveLength(2);
    });

    it('caps resultsWanted at 30 pages x 30 rows', async () => {
      let next = 0;
      mockPost.mockImplementation(async () => {
        const n = next++;
        const rows = Array.from({ length: 30 }, (_, i) => listing(n * 100 + i + 1));
        return ok(page(rows, [{ cursor: `c${n + 2}`, pageNumber: n + 2 }]));
      });

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 5000 }));

      expect(mockPost).toHaveBeenCalledTimes(30);
      expect(result.jobs).toHaveLength(900);
    });

    it('offset discards the first N new rows', async () => {
      mockPost.mockResolvedValue(ok(fixtureJson('graph-page1.json')));

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 2, offset: 1 }));

      expect(result.jobs.map((j) => j.id)).toEqual(['gd-1002', 'gd-1003']);
      expect(mockPost).toHaveBeenCalledTimes(1);
    });

    it('sleeps only between two requests, never after the last one', async () => {
      const { randomSleep } = jest.requireMock('@ever-jobs/common') as { randomSleep: jest.Mock };
      mockPost
        .mockResolvedValueOnce(ok(page([listing(1)], [{ cursor: 'c2', pageNumber: 2 }])))
        .mockResolvedValueOnce(ok(page([listing(2)], [])));

      await new GlassdoorService().scrape(input({ resultsWanted: 10 }));

      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(randomSleep).toHaveBeenCalledTimes(1);
    });
  });

  describe('A4 / A5 / A9: mapping', () => {
    beforeEach(() => {
      mockGet.mockResolvedValue(ok(HOME_WITH_TOKEN_HTML));
      mockPost.mockResolvedValue(ok(fixtureJson('graph-page1.json')));
    });

    it('keeps listings that share an ad order, with ids from the listing id', async () => {
      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10 }));

      expect(result.jobs.map((j) => j.id)).toEqual(['gd-1001', 'gd-1002', 'gd-1003']);
    });

    it('the ids legacy mode restores ad-order ids (and their collapsing)', async () => {
      process.env[GLASSDOOR_LEGACY_ENV] = 'ids';

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10 }));

      expect(result.jobs.map((j) => j.id)).toEqual(['gd-555', 'gd-777']);
    });

    it('builds canonical job URLs and company URLs', async () => {
      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10 }));
      const [first] = result.jobs;

      expect(first.jobUrl).toBe('https://www.glassdoor.com/job-listing/j?jl=1001');
      expect(first.companyUrl).toBe('https://www.glassdoor.com/Overview/W-EI_IE12345.htm');
    });

    it('the job-url legacy mode restores the SEO link', async () => {
      process.env[GLASSDOOR_LEGACY_ENV] = 'job-url';

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10 }));

      expect(result.jobs[0].jobUrl).toBe(
        'https://www.glassdoor.com/job-listing/software-engineer-acme-robotics-JV_IC1139761_KO0,17_KE18,31.htm?jl=1001',
      );
      expect(result.jobs[1].jobUrl).toBe('https://www.glassdoor.com/partner/jobListing.htm?pos=102&ao=555&jl=1002');
    });

    it('flags isRemote only on the Remote pseudo-location row', async () => {
      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10 }));

      expect(result.jobs.map((j) => [j.id, j.isRemote])).toEqual([
        ['gd-1001', false],
        ['gd-1002', false],
        ['gd-1003', true],
      ]);
    });

    it('a remote search marks every row remote', async () => {
      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10, isRemote: true }));

      expect(result.jobs.every((j) => j.isRemote === true)).toBe(true);
      expect(mockPost.mock.calls[0][1].variables.filterParams).toEqual([{ filterKey: 'remoteWorkType', values: '1' }]);
    });

    it('the remote legacy mode restores locationType === S', async () => {
      process.env[GLASSDOOR_LEGACY_ENV] = 'remote';

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10 }));

      expect(result.jobs.map((j) => j.isRemote)).toEqual([false, true, true]);
    });

    it('maps rating, listing type, location list and compensation', async () => {
      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10 }));
      const [austin, california, remote] = result.jobs;

      expect(austin.companyRating).toBe(4.2);
      expect(california.companyRating).toBeNull();
      expect(austin.listingType).toBe('sponsored');
      expect(california.listingType).toBeNull();
      expect(austin.location).toMatchObject({ city: 'Austin', state: 'TX' });
      expect(austin.locations).toEqual([expect.objectContaining({ city: 'Austin', state: 'TX' })]);
      expect(california.location).toMatchObject({ state: 'CA' });
      expect(remote.location).toEqual(expect.objectContaining({}));
      expect(remote.workFromHomeType).toBe('Remote');
      expect(austin.compensation).toMatchObject({ minAmount: 110000, maxAmount: 150000, currency: 'USD' });
      expect(austin.companyLogo).toBe('https://media.example/acme.png');
      expect(austin.emails).toEqual(['jobs@acme.example']);
    });

    it('the listing-type legacy mode restores sponsored / null', async () => {
      process.env[GLASSDOOR_LEGACY_ENV] = 'listing-type';
      const data = fixtureJson('graph-page1.json');
      data.data.jobListings.jobListings[1].jobview.header.adOrderSponsorshipLevel = 'STANDARD';
      mockPost.mockReset();
      mockPost.mockResolvedValue(ok(data));

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10 }));

      expect(result.jobs.map((j) => j.listingType)).toEqual(['sponsored', null, null]);
    });

    it('converts the description to markdown when asked', async () => {
      const result = await new GlassdoorService().scrape(
        input({ resultsWanted: 1, descriptionFormat: DescriptionFormat.MARKDOWN }),
      );

      expect(result.jobs[0].description).toContain('**robots**');
    });
  });

  describe('posted time (Spec 1696 integration)', () => {
    const NOW = Date.UTC(2026, 8, 24, 15, 30, 0);

    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW);
      mockGet.mockResolvedValue(ok('<html><script>var gdCSRF = "tok";</script></html>'));
      mockPost.mockResolvedValue(ok(fixtureJson('graph-page1.json')));
    });

    afterEach(() => jest.restoreAllMocks());

    it('ageInDays 0 / 5 / null -> day-precision relative dates, no instant', async () => {
      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10 }));
      const [today, fiveDays, unknown] = result.jobs;

      expect(today.datePosted).toBe(toDateOnly(NOW));
      expect(fiveDays.datePosted).toBe(toDateOnly(NOW - 5 * 86_400_000));
      expect(today.datePostedPrecision).toBe('day');
      expect(today.datePostedBasis).toBe('relative');
      expect(today).not.toHaveProperty('datePostedAt');
      expect(unknown.datePosted).toBeNull();
      expect(unknown).not.toHaveProperty('datePostedPrecision');
      expect(postHeaders()['gd-csrf-token']).toBe('tok');
    });

    it('a negative ageInDays gives no date instead of a future one', async () => {
      const data = fixtureJson('graph-page1.json');
      data.data.jobListings.jobListings[0].jobview.header.ageInDays = -3;
      mockPost.mockReset();
      mockPost.mockResolvedValue(ok(data));

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 1 }));

      expect(result.jobs[0].datePosted).toBeNull();
    });
  });

  describe('A6: location post-filter', () => {
    beforeEach(() => {
      mockGet.mockResolvedValue(ok(HOME_WITH_TOKEN_HTML));
      mockPost.mockResolvedValue(ok(fixtureJson('graph-page1.json')));
    });

    it('keeps only rows in the requested city, with no extra requests', async () => {
      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10, location: 'Austin, TX' }));

      expect(result.jobs.map((j) => j.id)).toEqual(['gd-1001']);
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(result.diagnostics).toBeUndefined();
    });

    it('keeps the requested state', async () => {
      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10, location: 'California' }));

      expect(result.jobs.map((j) => j.id)).toEqual(['gd-1002']);
    });

    it('keeps remote rows only in a remote search', async () => {
      const result = await new GlassdoorService().scrape(
        input({ resultsWanted: 10, location: 'Austin, TX', isRemote: true }),
      );

      expect(result.jobs.map((j) => j.id)).toEqual(['gd-1001', 'gd-1003']);
    });

    it('reports how many rows the filter removed when nothing is left', async () => {
      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10, location: 'Denver, CO' }));

      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('empty');
      expect(result.diagnostics?.detail).toContain('kept 0 of 3 rows');
    });

    it('does not filter on a location that parses to nothing', async () => {
      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10, location: 'Remote' }));

      expect(result.jobs).toHaveLength(3);
    });

    it('the location-filter legacy mode ignores input.location', async () => {
      process.env[GLASSDOOR_LEGACY_ENV] = 'location-filter';

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10, location: 'Austin, TX' }));

      expect(result.jobs).toHaveLength(3);
    });

    it('offset counts matching rows only', async () => {
      mockPost.mockReset();
      mockPost.mockResolvedValue(
        ok(page([listing(1, 'Austin, TX'), listing(2, 'Dallas, TX'), listing(3, 'Austin, TX')], [])),
      );

      const result = await new GlassdoorService().scrape(
        input({ resultsWanted: 10, offset: 1, location: 'Austin, TX' }),
      );

      expect(result.jobs.map((j) => j.id)).toEqual(['gd-3']);
    });
  });

  describe('A7: headers and regional domains', () => {
    beforeEach(() => {
      mockGet.mockResolvedValue(ok(HOME_WITH_TOKEN_HTML));
    });

    it('uses the country domain for origin, referer and the search URL; the homepage GET has no content-type', async () => {
      const data = fixtureJson('graph-page1.json');
      delete data.data.jobListings.jobListings[0].jobview.header.payCurrency;
      mockPost.mockResolvedValue(ok(data));

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 10, country: Country.UK }));

      expect(mockGet.mock.calls[0][0]).toBe('https://www.glassdoor.co.uk/');
      const getHeaders = mockGet.mock.calls[0][1].headers;
      expect(getHeaders).not.toHaveProperty('content-type');
      expect(getHeaders.accept).toContain('text/html');

      expect(mockPost.mock.calls[0][0]).toBe('https://www.glassdoor.co.uk/graph');
      expect(postHeaders().origin).toBe('https://www.glassdoor.co.uk');
      expect(postHeaders().referer).toBe('https://www.glassdoor.co.uk/');
      expect(postHeaders()).not.toHaveProperty('authority');
      expect(mockSetHeaders).not.toHaveBeenCalled();

      expect(result.jobs[0].jobUrl).toBe('https://www.glassdoor.co.uk/job-listing/j?jl=1001');
      expect(result.jobs[0].compensation?.currency).toBe('GBP');
    });

    it('the currency legacy mode restores USD for a missing payCurrency', async () => {
      process.env[GLASSDOOR_LEGACY_ENV] = 'currency';
      const data = fixtureJson('graph-page1.json');
      delete data.data.jobListings.jobListings[0].jobview.header.payCurrency;
      mockPost.mockResolvedValue(ok(data));

      const result = await new GlassdoorService().scrape(input({ resultsWanted: 1, country: Country.UK }));

      expect(result.jobs[0].compensation?.currency).toBe('USD');
    });

    it('drops the browser client hints when the caller supplies its own user agent', async () => {
      mockPost.mockResolvedValue(ok(fixtureJson('graph-page1.json')));

      await new GlassdoorService().scrape(input({ resultsWanted: 1, userAgent: 'CustomAgent/1.0' }));

      expect(Object.keys(postHeaders()).filter((k) => k.startsWith('sec-ch-'))).toEqual([]);
      expect(postHeaders()).not.toHaveProperty('user-agent');
    });

    it('the headers legacy mode restores the client-wide header map', async () => {
      process.env[GLASSDOOR_LEGACY_ENV] = 'headers';
      mockPost.mockResolvedValue(ok(fixtureJson('graph-page1.json')));

      await new GlassdoorService().scrape(input({ resultsWanted: 1 }));

      expect(mockSetHeaders).toHaveBeenCalledWith(GLASSDOOR_HEADERS);
      expect(mockGet.mock.calls[0]).toHaveLength(1);
      expect(postHeaders()).toEqual({ 'gd-csrf-token': SITE_TOKEN });
    });
  });

  it('a country without a Glassdoor domain reports bad_input and makes no request', async () => {
    const result = await new GlassdoorService().scrape(input({ country: Country.BAHRAIN }));

    expect(result.diagnostics?.reason).toBe('bad_input');
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
