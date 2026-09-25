import * as fs from 'fs';
import * as path from 'path';
import { Country, LocationDto } from '@ever-jobs/models';
import { parseLocationList } from '@ever-jobs/common';
import {
  GLASSDOOR_HARD_MAX_PAGES,
  GLASSDOOR_HEADERS,
  GLASSDOOR_LEGACY_BEHAVIOURS,
  GLASSDOOR_LEGACY_ENV,
  GLASSDOOR_MAX_PAGES,
  GLASSDOOR_MAX_PAGES_ENV,
  readGlassdoorOptions,
} from '../src/glassdoor.constants';
import {
  buildHeaders,
  canonicalJobUrl,
  challengeDetail,
  companyRatingOf,
  companyUrlOf,
  extractCsrfToken,
  glassdoorUrl,
  graphErrorDetail,
  headerJobUrl,
  headerValue,
  isChallengePage,
  isRemoteListing,
  listingIdOf,
  listingTypeOf,
  matchesRequestedLocation,
  mergeCursors,
  parseCompensation,
  readGraphBody,
  requestedLocationOf,
} from '../src/glassdoor.utils';

/** Spec 1703: unit tests for the robots-neutral hardening helpers. */

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const fixtureText = (name: string): string => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
const fixtureJson = (name: string): unknown => JSON.parse(fixtureText(name));

const CHALLENGE_HTML = fixtureText('challenge.html');
const HOME_WITH_TOKEN_HTML = fixtureText('home-with-token.html');

describe('isChallengePage', () => {
  it('flags the challenge fixture', () => {
    expect(isChallengePage(CHALLENGE_HTML)).toBe(true);
  });

  it('flags a bare cf-mitigated: challenge header, whatever the body', () => {
    expect(isChallengePage('', { 'cf-mitigated': 'challenge' })).toBe(true);
    expect(isChallengePage('<html>ok</html>', { 'Cf-Mitigated': 'Challenge' })).toBe(true);
  });

  it('flags the site interstitial title on its own', () => {
    expect(isChallengePage('<html><head><title> Security | Glassdoor </title></head></html>')).toBe(true);
  });

  it('does not flag a normal homepage', () => {
    expect(isChallengePage(HOME_WITH_TOKEN_HTML)).toBe(false);
    expect(isChallengePage(HOME_WITH_TOKEN_HTML, { 'content-type': 'text/html' })).toBe(false);
  });

  it('is false for non-string bodies and missing headers', () => {
    expect(isChallengePage(undefined)).toBe(false);
    expect(isChallengePage({ data: 1 })).toBe(false);
    expect(isChallengePage(null, null)).toBe(false);
  });
});

describe('challengeDetail / headerValue', () => {
  it('names the status and the mitigation header', () => {
    expect(challengeDetail('homepage', 403, { 'cf-mitigated': 'challenge' })).toBe(
      'homepage challenge (HTTP 403, cf-mitigated: challenge)',
    );
    expect(challengeDetail('search', undefined)).toBe('search challenge (HTTP ?)');
  });

  it('reads headers case-insensitively and joins arrays', () => {
    expect(headerValue({ 'Set-Cookie': ['a=1', 'b=2'] }, 'set-cookie')).toBe('a=1, b=2');
    expect(headerValue({ 'content-length': 12 }, 'Content-Length')).toBe('12');
    expect(headerValue({ other: 'x' }, 'cf-mitigated')).toBeNull();
    expect(headerValue(undefined, 'cf-mitigated')).toBeNull();
  });
});

describe('extractCsrfToken', () => {
  it('returns null for a challenge page (the beacon-token pitfall)', () => {
    expect(extractCsrfToken(CHALLENGE_HTML)).toBeNull();
  });

  it('returns the colon-separated site token and ignores the beacon token', () => {
    expect(extractCsrfToken(HOME_WITH_TOKEN_HTML)).toBe('AbCdEf012345_-xyz:QwErTy987654_-abc:ZxCvBn456');
  });

  it('returns null for a page whose only token is an analytics beacon', () => {
    const html =
      '<html><body><script data-cf-beacon=\'{"token":"0123456789abcdef0123456789abcdef"}\'></script></body></html>';
    expect(extractCsrfToken(html)).toBeNull();
    const doubleQuoted =
      '<script data-cf-beacon="{&quot;token&quot;:&quot;0123456789abcdef0123456789abcdef&quot;}"></script>';
    expect(extractCsrfToken(doubleQuoted)).toBeNull();
  });

  it('rejects a 32-hex or colon-less "token" outside a beacon attribute', () => {
    expect(extractCsrfToken('<script>x={"token":"0123456789abcdef0123456789abcdef"}</script>')).toBeNull();
    expect(extractCsrfToken('<script>x={"token":"abcdefghijklmnopqrstuvwxyz"}</script>')).toBeNull();
  });

  it('keeps the legacy gdCSRF assignment as a secondary match', () => {
    expect(extractCsrfToken('<script>var gdCSRF = "x";</script>')).toBe('x');
  });

  it('prefers the site token over the legacy assignment', () => {
    expect(
      extractCsrfToken('<script>var gdCSRF = "old";x={"token":"aaaaaaaaaaaa:bbbbbbbbbbbb"}</script>'),
    ).toBe('aaaaaaaaaaaa:bbbbbbbbbbbb');
  });

  it('returns null for empty or non-string input', () => {
    expect(extractCsrfToken('')).toBeNull();
    expect(extractCsrfToken(undefined)).toBeNull();
    expect(extractCsrfToken({ token: 'a:b' })).toBeNull();
  });
});

describe('readGraphBody', () => {
  it('reads the object form', () => {
    const body = readGraphBody(fixtureJson('graph-page1.json'));
    expect(body.listings).toHaveLength(3);
    expect(body.cursors).toEqual([{ cursor: 'cursor-page-1', pageNumber: 1 }]);
    expect(body.errors).toEqual([]);
    expect(body.nonJson).toBe(false);
  });

  it('reads the batched (array) form and keeps listings despite non-fatal errors', () => {
    const body = readGraphBody(fixtureJson('graph-errors-with-data.json'));
    expect(body.listings).toHaveLength(1);
    expect(body.errors).toEqual(['Service unavailable: seo metadata']);
  });

  it('returns the error text and null listings when there is no data', () => {
    const body = readGraphBody(fixtureJson('graph-errors-only.json'));
    expect(body.listings).toBeNull();
    expect(body.errors).toEqual(['Unknown type "FilterParamInput"']);
    expect(graphErrorDetail(body.errors)).toBe('graphql: Unknown type "FilterParamInput"');
  });

  it('marks an empty object as neither data nor errors', () => {
    expect(readGraphBody({})).toEqual({ listings: null, cursors: [], errors: [], nonJson: false, challenge: false });
    expect(readGraphBody([])).toEqual({ listings: null, cursors: [], errors: [], nonJson: false, challenge: false });
  });

  it('marks an HTML body as non-JSON, and a challenge body as a challenge', () => {
    expect(readGraphBody('<html>hello</html>')).toMatchObject({ listings: null, nonJson: true, challenge: false });
    expect(readGraphBody(CHALLENGE_HTML)).toMatchObject({ listings: null, nonJson: true, challenge: true });
    expect(readGraphBody('', { 'cf-mitigated': 'challenge' })).toMatchObject({ challenge: true });
    expect(readGraphBody(undefined)).toMatchObject({ listings: null, nonJson: true });
  });

  it('treats a data object without a listing array as an empty page', () => {
    expect(readGraphBody({ data: { jobListings: {} } }).listings).toEqual([]);
  });

  it('drops malformed cursors and stringifies message-less errors', () => {
    const body = readGraphBody({
      errors: [{ code: 'X' }, 'plain', { message: '' }],
      data: { jobListings: { jobListings: [], paginationCursors: [{ cursor: 'ok', pageNumber: 2 }, { cursor: 3 }, null] } },
    });
    expect(body.cursors).toEqual([{ cursor: 'ok', pageNumber: 2 }]);
    expect(body.errors).toEqual(['{"code":"X"}', 'plain']);
  });

  it('truncates a long error detail', () => {
    const detail = graphErrorDetail(['x'.repeat(1000)]);
    expect(detail.length).toBe('graphql: '.length + 280);
  });
});

describe('mergeCursors', () => {
  it('merges by page number, newer wins, sorted', () => {
    expect(
      mergeCursors(
        [{ cursor: 'a1', pageNumber: 1 }, { cursor: 'a2', pageNumber: 2 }],
        [{ cursor: 'b2', pageNumber: 2 }, { cursor: 'b3', pageNumber: 3 }],
      ),
    ).toEqual([
      { cursor: 'a1', pageNumber: 1 },
      { cursor: 'b2', pageNumber: 2 },
      { cursor: 'b3', pageNumber: 3 },
    ]);
  });
});

describe('isRemoteListing', () => {
  const remoteText = (text: string): boolean => parseLocationList([text]).remoteMentioned;

  it('is true on the Remote pseudo-location (locId 11047, type S)', () => {
    expect(isRemoteListing({ locationType: 'S', locId: 11047 }, false)).toBe(true);
    expect(isRemoteListing({ locationType: 'S', locId: '11047' }, false)).toBe(true);
  });

  it('is false for an ordinary state-level listing', () => {
    expect(isRemoteListing({ locationType: 'S', locId: 2280, locationName: 'California' }, remoteText('California'))).toBe(false);
  });

  it('is true when the location text says Remote', () => {
    expect(isRemoteListing({ locationType: 'C', locId: 1 }, remoteText('Remote'))).toBe(true);
  });

  it('needs type S for the pseudo-location id', () => {
    expect(isRemoteListing({ locationType: 'C', locId: 11047 }, false)).toBe(false);
    expect(isRemoteListing(undefined, false)).toBe(false);
  });
});

describe('URL building', () => {
  it('never produces // after the host on a regional domain', () => {
    const url = glassdoorUrl('job-listing/j?jl=1', 'https://www.glassdoor.co.uk/');
    expect(url).toBe('https://www.glassdoor.co.uk/job-listing/j?jl=1');
    expect(url.replace('https://', '')).not.toContain('//');
    expect(glassdoorUrl('/graph', 'https://fr.glassdoor.be/')).toBe('https://fr.glassdoor.be/graph');
  });

  it('builds the canonical job URL', () => {
    expect(canonicalJobUrl('1001', 'https://www.glassdoor.com/')).toBe('https://www.glassdoor.com/job-listing/j?jl=1001');
  });

  it('falls back to the header link, resolved, and refuses non-http schemes', () => {
    const base = 'https://www.glassdoor.ca/';
    expect(headerJobUrl({ seoJobLink: '/job-listing/x.htm?jl=5' }, base)).toBe('https://www.glassdoor.ca/job-listing/x.htm?jl=5');
    expect(headerJobUrl({ jobLink: 'partner/jobListing.htm?ao=1' }, base)).toBe('https://www.glassdoor.ca/partner/jobListing.htm?ao=1');
    expect(headerJobUrl({ jobLink: 'javascript:alert(1)' }, base)).toBe(base);
    expect(headerJobUrl({}, base)).toBe(base);
  });

  it('builds the company overview URL from a numeric employer id only', () => {
    expect(companyUrlOf({ employer: { id: 12345 } }, 'https://www.glassdoor.de/')).toBe(
      'https://www.glassdoor.de/Overview/W-EI_IE12345.htm',
    );
    expect(companyUrlOf({ employer: { id: '42' } }, 'https://www.glassdoor.com/')).toBe(
      'https://www.glassdoor.com/Overview/W-EI_IE42.htm',
    );
    expect(companyUrlOf({ employer: { id: 'x/../y' } }, 'https://www.glassdoor.com/')).toBeNull();
    expect(companyUrlOf({}, 'https://www.glassdoor.com/')).toBeNull();
  });
});

describe('listingIdOf', () => {
  it('prefers job.listingId', () => {
    expect(listingIdOf({ job: { listingId: 1001 }, header: { jobLink: '/x?jl=9' } })).toBe('1001');
    expect(listingIdOf({ job: { listingId: ' 1002 ' } })).toBe('1002');
  });

  it('falls back to the jl parameter of the job link', () => {
    expect(listingIdOf({ header: { jobLink: '/partner/jobListing.htm?ao=5&jl=777' } })).toBe('777');
    expect(listingIdOf({ header: { jobLink: '/partner/jobListing.htm?jobListingId=888' } })).toBe('888');
    expect(listingIdOf({ header: { seoJobLink: '/job-listing/x.htm?jl=999' } })).toBe('999');
  });

  it('returns null for non-numeric or missing ids', () => {
    expect(listingIdOf({ job: { listingId: 'abc' }, header: { jobLink: '/x?jl=abc' } })).toBeNull();
    expect(listingIdOf({ job: { listingId: -1 } })).toBeNull();
    expect(listingIdOf({})).toBeNull();
    expect(listingIdOf(undefined)).toBeNull();
  });
});

describe('mapping helpers', () => {
  it('listingTypeOf: sponsorship level, else sponsored, else null', () => {
    expect(listingTypeOf({ adOrderSponsorshipLevel: 'SPONSORED' })).toBe('sponsored');
    expect(listingTypeOf({ adOrderSponsorshipLevel: 'Premium', sponsored: false })).toBe('premium');
    expect(listingTypeOf({ sponsored: true })).toBe('sponsored');
    expect(listingTypeOf({ adOrderSponsorshipLevel: '  ', sponsored: false })).toBeNull();
  });

  it('companyRatingOf: positive numbers only', () => {
    expect(companyRatingOf({ rating: 4.2 })).toBe(4.2);
    expect(companyRatingOf({ rating: '3.5' })).toBe(3.5);
    expect(companyRatingOf({ rating: 0 })).toBeNull();
    expect(companyRatingOf({ rating: 'n/a' })).toBeNull();
    expect(companyRatingOf({})).toBeNull();
  });

  it('parseCompensation keeps USD as the default fallback and honours a given one', () => {
    const header = { payPeriod: 'HOURLY', payPeriodAdjustedPay: { p10: 20, p90: 30 } };
    expect(parseCompensation(header)?.currency).toBe('USD');
    expect(parseCompensation(header, 'GBP')?.currency).toBe('GBP');
    expect(parseCompensation({ ...header, payCurrency: 'EUR' }, 'GBP')?.currency).toBe('EUR');
    expect(parseCompensation({ ...header, payCurrency: '' }, 'GBP')?.currency).toBe('GBP');
    expect(parseCompensation({ payPeriodAdjustedPay: null })).toBeNull();
  });
});

describe('buildHeaders', () => {
  it('document: an HTML accept, no JSON content-type, no fetch metadata, no client hints', () => {
    const h = buildHeaders('https://www.glassdoor.co.uk/', 'document');
    expect(h.accept).toContain('text/html');
    expect(h).not.toHaveProperty('content-type');
    expect(Object.keys(h).filter((k) => k.startsWith('sec-'))).toEqual([]);
    expect(h).not.toHaveProperty('origin');
    expect(h).not.toHaveProperty('user-agent');
  });

  it('api: origin and referer follow the country domain; no authority, no user-agent', () => {
    const h = buildHeaders('https://www.glassdoor.co.uk/', 'api');
    expect(h.origin).toBe('https://www.glassdoor.co.uk');
    expect(h.referer).toBe('https://www.glassdoor.co.uk/');
    expect(h['content-type']).toBe('application/json');
    expect(h).not.toHaveProperty('authority');
    expect(h).not.toHaveProperty('user-agent');
    expect(buildHeaders('https://fr.glassdoor.be/', 'api').origin).toBe('https://fr.glassdoor.be');
  });

  it('api: every value is one the request already carried before Spec 1703 (nothing new)', () => {
    const h = buildHeaders('https://www.glassdoor.com/', 'api');
    for (const [key, value] of Object.entries(h)) {
      expect(GLASSDOOR_HEADERS).toHaveProperty(key);
      expect(value).toBe(GLASSDOOR_HEADERS[key]);
    }
  });

  it('api: client hints are dropped when the caller supplies its own UA', () => {
    const withHints = buildHeaders('https://www.glassdoor.com/', 'api');
    const without = buildHeaders('https://www.glassdoor.com/', 'api', { clientHints: false });
    expect(withHints).toHaveProperty('sec-ch-ua');
    expect(Object.keys(without).filter((k) => k.startsWith('sec-ch-'))).toEqual([]);
  });
});

describe('location post-filter matching', () => {
  const row = (text: string): LocationDto | null => parseLocationList([text]).location;
  const want = (text: string): LocationDto => requestedLocationOf(text) as LocationDto;

  it('matches the same city and state', () => {
    expect(matchesRequestedLocation(row('Austin, TX'), want('Austin, TX'), Country.USA)).toBe(true);
    expect(matchesRequestedLocation(row('Austin, Texas'), want('austin, tx'), Country.USA)).toBe(true);
  });

  it('rejects another city, or the same city in another state', () => {
    expect(matchesRequestedLocation(row('Dallas, TX'), want('Austin, TX'), Country.USA)).toBe(false);
    expect(matchesRequestedLocation(row('Austin, MN'), want('Austin, TX'), Country.USA)).toBe(false);
  });

  it('is diacritic- and case-insensitive', () => {
    expect(matchesRequestedLocation(row('São Paulo, SP'), want('sao paulo'), Country.BRAZIL)).toBe(true);
  });

  it('matches on state when no city was asked for', () => {
    expect(matchesRequestedLocation(row('California'), want('California'), Country.USA)).toBe(true);
    expect(matchesRequestedLocation(row('San Francisco, CA'), want('California'), Country.USA)).toBe(true);
    expect(matchesRequestedLocation(row('Austin, TX'), want('California'), Country.USA)).toBe(false);
  });

  it('matches on country, taking the searched domain for rows without one', () => {
    expect(matchesRequestedLocation(row('Austin, TX'), want('United States'), Country.USA)).toBe(true);
    expect(matchesRequestedLocation(row('Austin, TX'), want('Germany'), Country.USA)).toBe(false);
    expect(matchesRequestedLocation(row('Berlin, Germany'), want('Germany'), Country.USA)).toBe(true);
  });

  it('never matches a row without a location', () => {
    expect(matchesRequestedLocation(row('Remote'), want('Austin, TX'), Country.USA)).toBe(false);
    expect(matchesRequestedLocation(null, want('Austin, TX'), Country.USA)).toBe(false);
  });

  it('requestedLocationOf is null for text that parses to nothing', () => {
    expect(requestedLocationOf('Remote')).toBeNull();
    expect(requestedLocationOf('   ')).toBeNull();
    expect(requestedLocationOf(undefined)).toBeNull();
    expect(requestedLocationOf('Austin, TX')).toMatchObject({ city: 'Austin', state: 'TX' });
  });
});

describe('readGlassdoorOptions', () => {
  it('defaults: no legacy behaviour, default page cap', () => {
    const o = readGlassdoorOptions({});
    expect([...o.legacy]).toEqual([]);
    expect(o.maxPages).toBe(GLASSDOOR_MAX_PAGES);
  });

  it.each(['true', '1', 'yes', 'on', 'all', ' ALL '])('%p restores every legacy behaviour', (value) => {
    const o = readGlassdoorOptions({ [GLASSDOOR_LEGACY_ENV]: value });
    expect([...o.legacy].sort()).toEqual([...GLASSDOOR_LEGACY_BEHAVIOURS].sort());
  });

  it('a comma list restores only the named behaviours and ignores unknown names', () => {
    const o = readGlassdoorOptions({ [GLASSDOOR_LEGACY_ENV]: 'ids, job-url,bogus' });
    expect([...o.legacy].sort()).toEqual(['ids', 'job-url']);
  });

  it.each(['false', '0', 'off', ''])('%p restores nothing', (value) => {
    expect(readGlassdoorOptions({ [GLASSDOOR_LEGACY_ENV]: value }).legacy.size).toBe(0);
  });

  it('page cap: a positive integer overrides, clamped to the hard ceiling', () => {
    expect(readGlassdoorOptions({ [GLASSDOOR_MAX_PAGES_ENV]: '3' }).maxPages).toBe(3);
    expect(readGlassdoorOptions({ [GLASSDOOR_MAX_PAGES_ENV]: '5000' }).maxPages).toBe(GLASSDOOR_HARD_MAX_PAGES);
  });

  it.each(['0', '-2', 'abc', '2.5', ''])('page cap: %p keeps the default', (value) => {
    expect(readGlassdoorOptions({ [GLASSDOOR_MAX_PAGES_ENV]: value }).maxPages).toBe(GLASSDOOR_MAX_PAGES);
  });
});
