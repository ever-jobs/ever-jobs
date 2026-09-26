import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { Country, DatePostedBasis, DatePostedPrecision, Site } from '@ever-jobs/models';
import {
  BAYT_COUNTRY_PATHS,
  BAYT_ENV,
  BAYT_MAX_PAGES,
  BAYT_MAX_PAGES_CEILING,
  resolveBaytOptions,
} from '../src/bayt.constants';
import {
  baytFetchDiagnostics,
  baytHash,
  baytPostedLabel,
  buildSearchUrl,
  canonicalJobUrl,
  countryFromDisplayName,
  extractJobId,
  legacyBaytSlug,
  normaliseBaytLocation,
  parseBaytLocation,
  parseBaytLocationText,
  parseListing,
  parseRelativePosted,
  resolveCountryPath,
  toBaytSlug,
  toJobPost,
} from '../src/bayt.parse';

const FIX = join(__dirname, 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIX, name), 'utf-8');

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('toBaytSlug (Spec 1710)', () => {
  it.each([
    ['Straße Manager', 'strasse-manager'],
    ['Ærø pilot', 'aero-pilot'],
    ['Łódź analyst', 'lodz-analyst'],
    ['ingénieur logiciel', 'ingenieur-logiciel'],
    ['Ingénieur  Logiciel', 'ingenieur-logiciel'],
    ['front-end / UI', 'front-end-ui'],
    ['node.js', 'nodejs'],
    ['  Data   Scientist ', 'data-scientist'],
    ['İstanbul sales', 'istanbul-sales'],
    ['Python Developer', 'python-developer'],
    ['Œuvre þing đa ıi', 'oeuvre-thing-da-ii'],
    ['Ｐｙｔｈｏｎ', 'python'],
    ['---', ''],
    ['مهندس', ''],
    ['+++', ''],
    ['', ''],
  ])('%j -> %j', (term, slug) => {
    expect(toBaytSlug(term)).toBe(slug);
  });

  it('pins the symbol-stripping reading of C++ / C# (open question: how the site spells them)', () => {
    expect(toBaytSlug('C++ developer')).toBe('c-developer');
    expect(toBaytSlug('C# developer')).toBe('c-developer');
  });

  it('is total on non-strings', () => {
    expect(toBaytSlug(undefined)).toBe('');
    expect(toBaytSlug(null)).toBe('');
    expect(toBaytSlug(42 as unknown as string)).toBe('');
  });

  it('stays linear on a long hostile term', () => {
    const term = `${'a -'.repeat(20000)}!`;
    const started = Date.now();
    expect(toBaytSlug(term).startsWith('a-a-a')).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('legacyBaytSlug (pre-1710 slug, EVER_JOBS_BAYT_LEGACY_SLUG)', () => {
  it('keeps case and symbols, whitespace to "-"', () => {
    expect(legacyBaytSlug('Python Developer')).toBe('Python-Developer');
    expect(legacyBaytSlug('C++ developer')).toBe('C++-developer');
  });

  it('cannot add a path segment or a query parameter', () => {
    const slug = legacyBaytSlug('a/b?sort=x#frag');
    expect(slug).toBe('a%2Fb%3Fsort=x%23frag');
    const url = new URL(buildSearchUrl('international', slug, 1));
    expect(url.search).toBe('?page=1');
    expect(url.hash).toBe('');
    expect(url.pathname).toBe('/en/international/jobs/a%2Fb%3Fsort=x%23frag-jobs/');
  });

  it('is refused by the robots guard when it spells a filter parameter', () => {
    expect(() => buildSearchUrl('international', legacyBaytSlug('x filters[a]'), 1)).toThrow(
      /robots-disallowed/,
    );
  });

  it('percent-encodes non-ASCII as the HTTP client would', () => {
    expect(legacyBaytSlug('ingénieur')).toBe('ing%C3%A9nieur');
  });
});

describe('buildSearchUrl', () => {
  it('builds the search form exactly', () => {
    expect(buildSearchUrl('international', 'software-engineer', 1)).toBe(
      'https://www.bayt.com/en/international/jobs/software-engineer-jobs/?page=1',
    );
  });

  it('browses the market when the slug is empty', () => {
    expect(buildSearchUrl('uae', '', 3)).toBe('https://www.bayt.com/en/uae/jobs/?page=3');
  });

  it('never emits the robots-disallowed country-less /en/jobs/ path', () => {
    const paths = [...Object.values(BAYT_COUNTRY_PATHS), 'international'];
    for (const countryPath of paths) {
      for (const slug of ['', 'python-developer', toBaytSlug('C++'), legacyBaytSlug('a b')]) {
        const url = new URL(buildSearchUrl(countryPath as string, slug, 1));
        expect(url.pathname.startsWith('/en/jobs/')).toBe(false);
        expect(url.search).toBe('?page=1');
      }
    }
  });

  it('refuses robots-disallowed filter spellings in the slug', () => {
    for (const slug of ['filters[', 'x-filters%5bdate', 'options[', 'OPTIONS%5D']) {
      expect(() => buildSearchUrl('uae', slug, 1)).toThrow(/robots-disallowed/);
    }
    // A plain word is fine.
    expect(buildSearchUrl('uae', 'filters-engineer', 1)).toContain('/filters-engineer-jobs/');
  });

  it('refuses an empty or unsafe market segment instead of building a bad path', () => {
    expect(() => buildSearchUrl('', 'python', 1)).toThrow(/market segment/);
    expect(() => buildSearchUrl('uae/../jobs', 'python', 1)).toThrow(/market segment/);
    expect(() => buildSearchUrl('uae?filters[', 'python', 1)).toThrow(/market segment/);
  });

  it('normalises a nonsense page number to 1', () => {
    expect(buildSearchUrl('uae', 'x', 0)).toMatch(/\?page=1$/);
    expect(buildSearchUrl('uae', 'x', Number.NaN)).toMatch(/\?page=1$/);
  });
});

describe('resolveCountryPath', () => {
  it.each([
    [Country.UNITEDARABEMIRATES, 'uae'],
    [Country.SAUDIARABIA, 'saudi-arabia'],
    [Country.QATAR, 'qatar'],
    [Country.EGYPT, 'egypt'],
    [Country.GERMANY, 'international'],
    [Country.WORLDWIDE, 'international'],
    [Country.USA, 'international'],
  ])('%s -> %s', (country, path) => {
    expect(resolveCountryPath({ country })).toBe(path);
  });

  it('reads a Bayt market from location when country is unset', () => {
    expect(resolveCountryPath({ location: 'Dubai, UAE' })).toBe('uae');
    expect(resolveCountryPath({ location: 'Riyadh, Saudi Arabia' })).toBe('saudi-arabia');
  });

  it('reads location when country is the DTO default (not a Bayt market)', () => {
    expect(resolveCountryPath({ country: Country.USA, location: 'Dubai, UAE' })).toBe('uae');
  });

  it('prefers an explicit Bayt-market country over location', () => {
    expect(
      resolveCountryPath({ country: Country.QATAR, location: 'Dubai, UAE' }),
    ).toBe('qatar');
  });

  it('keeps international for a city-only or non-market location', () => {
    expect(resolveCountryPath({ location: 'Dubai' })).toBe('international');
    expect(resolveCountryPath({ location: 'Berlin, Germany' })).toBe('international');
    expect(resolveCountryPath({})).toBe('international');
    expect(resolveCountryPath(undefined)).toBe('international');
  });
});

describe('countryFromDisplayName', () => {
  it('maps configured names, case-insensitively', () => {
    expect(countryFromDisplayName('United Arab Emirates')).toBe(Country.UNITEDARABEMIRATES);
    expect(countryFromDisplayName(' saudi arabia ')).toBe(Country.SAUDIARABIA);
    expect(countryFromDisplayName('Atlantis')).toBeNull();
    expect(countryFromDisplayName('')).toBeNull();
    expect(countryFromDisplayName(null)).toBeNull();
  });
});

describe('parseBaytLocation', () => {
  const cell = (html: string) => {
    const $ = cheerio.load(`<div class="t-mute t-small">${html}</div>`);
    return { $, el: $('div.t-mute.t-small') };
  };

  it('joins two anchors into City, Country', () => {
    const { $, el } = cell(
      '<a href="/en/uae/jobs/jobs-in-dubai/">Dubai</a> &middot; <a href="/en/uae/jobs/">United Arab Emirates</a>',
    );
    const parsed = parseBaytLocation($, el);
    expect(parsed?.location?.city).toBe('Dubai');
    expect(parsed?.location?.country).toBe('United Arab Emirates');
  });

  it('splits plain "City, Country" text', () => {
    const { $, el } = cell('Riyadh, Saudi Arabia');
    const parsed = parseBaytLocation($, el);
    expect(parsed?.location?.city).toBe('Riyadh');
    expect(parsed?.location?.country).toBe('Saudi Arabia');
  });

  it('treats a middle dot as a separator', () => {
    const { $, el } = cell('Amman &middot; Jordan');
    const parsed = parseBaytLocation($, el);
    expect(parsed?.location?.city).toBe('Amman');
    expect(parsed?.location?.country).toBe('Jordan');
  });

  it('promotes a regional country the parser reports as a state', () => {
    // Without ISO country names the shared parser reads "Amman, Jordan" as a state.
    const parsed = parseBaytLocationText('Amman · Jordan', { isoCountryNames: false });
    expect(parsed?.location?.country).toBe('Jordan');
    expect(parsed?.location?.state).toBeUndefined();
    expect(parsed?.locations[0]?.country).toBe('Jordan');

    const beirut = parseBaytLocationText('Beirut, Lebanon', { isoCountryNames: false });
    expect(beirut?.location?.country).toBe('Lebanon');
  });

  it('flags remote text', () => {
    const parsed = parseBaytLocationText('Remote');
    expect(parsed?.remoteMentioned).toBe(true);
    expect(parsed?.workFromHomeType).toBe('Remote');
  });

  it('returns null for an empty or missing cell - never a fabricated WORLDWIDE', () => {
    const { $, el } = cell('   ');
    expect(parseBaytLocation($, el)).toBeNull();
    expect(parseBaytLocation($, $('div.nope'))).toBeNull();
    expect(parseBaytLocation($, null)).toBeNull();
    expect(parseBaytLocationText(' · ')).toBeNull();
  });

  it('normalises separators and stray edge commas, bounded', () => {
    expect(normaliseBaytLocation('  Dubai  •  UAE | x ')).toBe('Dubai, UAE, x');
    expect(normaliseBaytLocation('· Dubai ·')).toBe('Dubai');
    expect(normaliseBaytLocation(`${' '.repeat(50000)}Dubai`)).toBe('');
    expect(normaliseBaytLocation(undefined)).toBe('');
  });
});

describe('extractJobId', () => {
  it('uses data-job-id first', () => {
    expect(
      extractJobId('5123456', 'https://www.bayt.com/en/uae/jobs/x-9999999/'),
    ).toEqual({ id: 'bayt-5123456', source: 'data-job-id' });
  });

  it('falls back to the trailing URL digits', () => {
    expect(
      extractJobId(undefined, 'https://www.bayt.com/en/saudi-arabia/jobs/backend-engineer-5123457/'),
    ).toEqual({ id: 'bayt-5123457', source: 'url' });
  });

  it('ignores a non-numeric data-job-id', () => {
    expect(
      extractJobId('abc', 'https://www.bayt.com/en/uae/jobs/x-5123459/').source,
    ).toBe('url');
  });

  it('hashes the canonical URL when there are no digits', () => {
    const url = 'https://www.bayt.com/en/uae/jobs/some-job/';
    expect(extractJobId(undefined, url)).toEqual({
      id: `bayt-${Math.abs(baytHash(url))}`,
      source: 'hash',
    });
    // Short digit runs are not ids.
    expect(extractJobId('', 'https://www.bayt.com/en/uae/jobs/job-123/').source).toBe('hash');
  });
});

describe('canonicalJobUrl', () => {
  it('strips the query string and fragment', () => {
    expect(
      canonicalJobUrl('/en/uae/jobs/senior-python-developer-5123456/?utm_source=list#apply'),
    ).toBe('https://www.bayt.com/en/uae/jobs/senior-python-developer-5123456/');
  });

  it('does not double-prefix an absolute href', () => {
    expect(
      canonicalJobUrl('https://www.bayt.com/en/saudi-arabia/jobs/backend-engineer-python-5123457/'),
    ).toBe('https://www.bayt.com/en/saudi-arabia/jobs/backend-engineer-python-5123457/');
  });

  it('refuses non-http schemes and blanks', () => {
    expect(canonicalJobUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalJobUrl('   ')).toBeNull();
    expect(canonicalJobUrl(undefined)).toBeNull();
  });
});

describe('parseRelativePosted / baytPostedLabel', () => {
  const now = new Date(NOW);

  it.each([
    ['Today', 0],
    ['today', 0],
    ['Just now', 0],
    ['Yesterday', DAY_MS],
    ['3 days ago', 3 * DAY_MS],
    ['30+ days ago', 30 * DAY_MS],
    ['2 weeks ago', 14 * DAY_MS],
    ['5 hours ago', 5 * 60 * 60 * 1000],
    ['1 month ago', 30 * DAY_MS],
    ['Posted 3 days ago', 3 * DAY_MS],
    ['Active 3 days ago', 3 * DAY_MS],
  ])('%j is %d ms old', (text, ageMs) => {
    expect(parseRelativePosted(text, now)?.getTime()).toBe(NOW - ageMs);
  });

  it.each(['garbage', '', 'in 3 days', 'منذ 3 أيام', '3 days'])('%j -> null', (text) => {
    expect(parseRelativePosted(text, now)).toBeNull();
  });

  it('accepts a numeric now and is null for a bad clock', () => {
    expect(parseRelativePosted('Today', NOW)?.getTime()).toBe(NOW);
    expect(parseRelativePosted('Today', Number.NaN)).toBeNull();
    expect(parseRelativePosted(null, NOW)).toBeNull();
  });

  it('extracts the label from surrounding text', () => {
    expect(baytPostedLabel('  Active\n  3 days ago · Easy apply ')).toBe('3 days ago');
    expect(baytPostedLabel('Today')).toBe('Today');
    expect(baytPostedLabel('recently')).toBeNull();
  });
});

describe('parseListing', () => {
  it('parses page 1: three cards, one broken', () => {
    const listing = parseListing(fixture('listing-page1.html'));
    expect(listing.cards).toBe(4);
    expect(listing.failed).toBe(1);
    expect(listing.jobs.map((j) => j.id)).toEqual([
      'bayt-5123456',
      'bayt-5123457',
      'bayt-5123458',
    ]);
    const [first, second, third] = listing.jobs;
    expect(first.idSource).toBe('data-job-id');
    expect(second.idSource).toBe('url');
    expect(first.title).toBe('Senior Python Developer');
    expect(first.jobUrl).toBe('https://www.bayt.com/en/uae/jobs/senior-python-developer-5123456/');
    expect(first.companyName).toBe('Acme Labs');
    expect(first.companyUrl).toBe('https://www.bayt.com/en/company/acme-labs-1001/');
    expect(second.companyUrl).toBeNull();
    expect(first.postedLabel).toBe('Today');
    expect(second.postedAgeMs).toBe(3 * DAY_MS);
    expect(third.postedLabel).toBeNull();
    expect(third.postedAgeMs).toBeNull();
    expect(first.legacy.href).toBe('/en/uae/jobs/senior-python-developer-5123456/?utm_source=list');
  });

  it('counts cards that parse to nothing (markup drift)', () => {
    const listing = parseListing(fixture('listing-all-broken.html'));
    expect(listing).toEqual({ cards: 2, jobs: [], failed: 2 });
  });

  it('finds no cards on an empty page or a challenge', () => {
    expect(parseListing(fixture('listing-empty.html')).cards).toBe(0);
    expect(parseListing(fixture('challenge.html')).cards).toBe(0);
    expect(parseListing('').cards).toBe(0);
  });
});

describe('toJobPost', () => {
  const [first, second, third] = parseListing(fixture('listing-page1.html')).jobs;

  it('maps a card to the Spec 1710 JobPostDto', () => {
    const job = toJobPost(first, NOW);
    expect(job).toMatchObject({
      id: 'bayt-5123456',
      title: 'Senior Python Developer',
      companyName: 'Acme Labs',
      companyUrl: 'https://www.bayt.com/en/company/acme-labs-1001/',
      jobUrl: 'https://www.bayt.com/en/uae/jobs/senior-python-developer-5123456/',
      isRemote: null,
      workFromHomeType: null,
      datePosted: '2026-09-24',
      datePostedPrecision: DatePostedPrecision.DAY,
      datePostedBasis: DatePostedBasis.RELATIVE,
      site: Site.BAYT,
    });
    expect(job.location?.city).toBe('Dubai');
    expect(job.location?.country).toBe('United Arab Emirates');
    expect(job.locations).toHaveLength(1);
  });

  it('dates a "3 days ago" card and leaves an undated card null', () => {
    expect(toJobPost(second, NOW).datePosted).toBe('2026-09-21');
    const undated = toJobPost(third, NOW);
    expect(undated.datePosted).toBeNull();
    expect(undated.datePostedPrecision).toBeUndefined();
  });

  it('reproduces the pre-1710 mapping verbatim under legacyMapping', () => {
    const job = toJobPost(first, NOW, { legacyMapping: true });
    const legacyUrl =
      'https://www.bayt.com/en/uae/jobs/senior-python-developer-5123456/?utm_source=list';
    expect(job.jobUrl).toBe(legacyUrl);
    expect(job.id).toBe(`bayt-${Math.abs(baytHash(legacyUrl))}`);
    expect(job.title).toMatch(/^Senior\s{3}Python Developer$/);
    expect(job.location?.city).toBe('Dubai · United Arab Emirates');
    expect(job.location?.country).toBe(Country.WORLDWIDE);
    expect(job.datePosted).toBeUndefined();

    // The pre-1710 double-host URL for an absolute href is reproduced too.
    expect(toJobPost(second, NOW, { legacyMapping: true }).jobUrl).toBe(
      'https://www.bayt.comhttps://www.bayt.com/en/saudi-arabia/jobs/backend-engineer-python-5123457/',
    );
  });
});

describe('baytFetchDiagnostics', () => {
  const httpError = (status: number, headers: Record<string, unknown>, data: unknown = '') =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, headers, data },
    });

  it('names the managed challenge when cf-mitigated says so', () => {
    const diag = baytFetchDiagnostics(httpError(403, { 'cf-mitigated': 'challenge' }));
    expect(diag.reason).toBe('blocked');
    expect(diag.detail).toBe(
      'bayt.com served a Cloudflare managed challenge (HTTP 403, cf-mitigated: challenge)',
    );
  });

  it('reads the header through an AxiosHeaders-like getter and in any case', () => {
    const headers = { get: (k: string) => (k === 'cf-mitigated' ? 'challenge' : undefined) };
    expect(baytFetchDiagnostics(httpError(403, headers)).detail).toMatch(/managed challenge/);
    expect(
      baytFetchDiagnostics(httpError(403, { 'CF-Mitigated': ['challenge'] })).detail,
    ).toMatch(/managed challenge/);
  });

  it('reads a challenge body on a non-403 status as blocked', () => {
    const diag = baytFetchDiagnostics(httpError(503, {}, fixture('challenge.html')));
    expect(diag.reason).toBe('blocked');
    expect(diag.detail).toBe('bayt.com served a bot challenge page (HTTP 503)');
  });

  it('defers to the shared classifier otherwise', () => {
    expect(baytFetchDiagnostics(httpError(403, {})).reason).toBe('blocked');
    expect(baytFetchDiagnostics(httpError(404, {})).reason).toBe('bad_input');
    expect(baytFetchDiagnostics(new Error('timeout of 30000ms exceeded')).reason).toBe('timeout');
    expect(baytFetchDiagnostics('weird').reason).toBe('unknown');
  });
});

describe('resolveBaytOptions', () => {
  it('defaults to the Spec 1710 behaviour', () => {
    expect(resolveBaytOptions({}, {})).toEqual({
      legacyMapping: false,
      legacySlug: false,
      countryScope: true,
      maxPages: BAYT_MAX_PAGES,
    });
  });

  it('reads the env switches', () => {
    expect(
      resolveBaytOptions(
        {},
        {
          [BAYT_ENV.legacyMapping]: 'true',
          [BAYT_ENV.legacySlug]: 'on',
          [BAYT_ENV.countryScope]: 'false',
          [BAYT_ENV.maxPages]: '3',
        },
      ),
    ).toEqual({ legacyMapping: true, legacySlug: true, countryScope: false, maxPages: 3 });
  });

  it('lets an explicit override win and ignores junk', () => {
    const opts = resolveBaytOptions(
      { legacyMapping: false, maxPages: 999 },
      { [BAYT_ENV.legacyMapping]: 'true', [BAYT_ENV.countryScope]: 'maybe', [BAYT_ENV.maxPages]: 'x' },
    );
    expect(opts.legacyMapping).toBe(false);
    expect(opts.countryScope).toBe(true);
    expect(opts.maxPages).toBe(BAYT_MAX_PAGES_CEILING);
    expect(resolveBaytOptions({}, { [BAYT_ENV.maxPages]: '0' }).maxPages).toBe(BAYT_MAX_PAGES);
  });
});
