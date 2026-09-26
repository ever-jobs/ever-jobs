import * as fs from 'fs';
import * as path from 'path';
import * as cheerio from 'cheerio';
import {
  CompensationInterval,
  Country,
  DatePostedBasis,
  DatePostedPrecision,
  DescriptionFormat,
  JobType,
  Site,
} from '@ever-jobs/models';
import {
  assertRobotsSafe,
  buildCardLocation,
  buildListingPath,
  buildListingUrl,
  cardId,
  cardJobTypes,
  cardMatchesFilters,
  cardToJobPost,
  classifyCanonical,
  cleanSearchTerm,
  composeDescription,
  hashCode,
  interleave,
  isRobotsSafeUrl,
  normaliseListingPath,
  normaliseSnippet,
  parseDetailDescription,
  parseInrPay,
  parseListingPage,
  parsePostedAge,
  planSearch,
  resolveCity,
  resolveInternshalaOptions,
  resolvePostedTime,
  slugEpochSeconds,
  toDetailPath,
} from '../src/internshala.parser';
import { CardFilters, InternshalaOptions, ListingQuery, ParsedCard } from '../src/internshala.types';

/**
 * Spec 1706 — pure parser and URL-builder tests (T1–T7). Fixtures are
 * synthetic: the listing markup structure with invented companies and text.
 */

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** 2026-09-24T19:46:34Z */
const NOW = Date.UTC(2026, 8, 24, 19, 46, 34);

const DEFAULT_OPTIONS: InternshalaOptions = {
  defaultStreams: 'both',
  idScheme: 'posting',
  maxPages: 10,
  slugTimestamp: true,
};

const NO_FILTERS: CardFilters = { remote: false, cityKeys: null, partTime: null, maxAgeHours: null };

function q(partial: Partial<ListingQuery>): ListingQuery {
  return { term: '', city: null, remote: false, ...partial };
}

const jobsPage = parseListingPage(fixture('jobs-page1.html'), 'job');
const internshipsPage = parseListingPage(fixture('internships-page1.html'), 'internship');
const jobCard = (id: string): ParsedCard => jobsPage.cards.find((c) => c.internshipId === id)!;
const internshipCard = (id: string): ParsedCard => internshipsPage.cards.find((c) => c.internshipId === id)!;

describe('Spec 1706 / T1 — listing URLs and the robots.txt guard', () => {
  it('builds the keyword listing for both streams', () => {
    expect(buildListingUrl('job', q({ term: 'python' }), 'keyword', 1)).toBe(
      'https://internshala.com/jobs/keywords-python/',
    );
    expect(buildListingUrl('internship', q({ term: 'python' }), 'keyword', 1)).toBe(
      'https://internshala.com/internships/keywords-python/',
    );
  });

  it('appends page-N/ from page 2 on', () => {
    expect(buildListingUrl('job', q({ term: 'python' }), 'keyword', 2)).toBe(
      'https://internshala.com/jobs/keywords-python/page-2/',
    );
    expect(buildListingUrl('internship', q({}), 'keyword', 3)).toBe('https://internshala.com/internships/page-3/');
  });

  it('uses the root listing when nothing was asked for', () => {
    expect(buildListingPath('job', q({}), 'keyword')).toBe('/jobs/');
    expect(buildListingPath('internship', q({}), 'narrow')).toBe('/internships/');
  });

  it('URL-encodes a multi-word keyword as %20', () => {
    const term = cleanSearchTerm('Data Science');
    expect(buildListingUrl('internship', q({ term }), 'keyword', 1)).toBe(
      'https://internshala.com/internships/keywords-data%20science/',
    );
  });

  it('strips robots-unsafe characters from the term before encoding', () => {
    const term = cleanSearchTerm('c++, rust?');
    expect(term).toBe('c++ rust');
    const url = buildListingUrl('job', q({ term }), 'keyword', 2);
    expect(url).toBe('https://internshala.com/jobs/keywords-c%2B%2B%20rust/page-2/');
    for (const bad of [',', '?', '%3F', '%3f', '%3D', '%3d', '#']) expect(url).not.toContain(bad);
    for (const raw of ['a=b', 'x&y', 'a/b', '50%', 'back\\slash', 'q#frag', 'what?=is']) {
      expect(isRobotsSafeUrl(buildListingUrl('job', q({ term: cleanSearchTerm(raw) }), 'keyword', 1))).toBe(true);
    }
  });

  it('caps a very long term at a word boundary', () => {
    const term = cleanSearchTerm(`${'python '.repeat(40)}developer`);
    expect(term.length).toBeLessThanOrEqual(100);
    expect(term.endsWith(' ')).toBe(false);
    expect(term.startsWith('python python')).toBe(true);
  });

  it('builds the narrow city and work-from-home forms', () => {
    expect(buildListingPath('job', q({ term: 'python', city: 'bangalore' }), 'narrow')).toBe(
      '/jobs/python-jobs-in-bangalore/',
    );
    expect(buildListingPath('internship', q({ term: 'python', city: 'bangalore' }), 'narrow')).toBe(
      '/internships/python-internship-in-bangalore/',
    );
    expect(buildListingPath('job', q({ city: 'bangalore' }), 'narrow')).toBe('/jobs/jobs-in-bangalore/');
    expect(buildListingPath('internship', q({ city: 'bangalore' }), 'narrow')).toBe(
      '/internships/internship-in-bangalore/',
    );
    expect(buildListingPath('job', q({ term: 'data science', remote: true }), 'narrow')).toBe(
      '/jobs/work-from-home-data-science-jobs/',
    );
    expect(buildListingPath('internship', q({ term: 'data science', remote: true }), 'narrow')).toBe(
      '/internships/work-from-home-data-science-internships/',
    );
    expect(buildListingPath('job', q({ remote: true }), 'narrow')).toBe('/jobs/work-from-home-jobs/');
    expect(buildListingPath('internship', q({ remote: true }), 'narrow')).toBe(
      '/internships/work-from-home-internships/',
    );
    // remote wins over a city: a work-from-home posting has no city
    expect(buildListingPath('job', q({ term: 'python', remote: true, city: 'pune' }), 'narrow')).toBe(
      '/jobs/work-from-home-python-jobs/',
    );
  });

  it('the keyword strategy ignores the narrowing and keeps the term', () => {
    expect(buildListingPath('job', q({ term: 'python', city: 'bangalore' }), 'keyword')).toBe('/jobs/keywords-python/');
    expect(buildListingPath('internship', q({ remote: true }), 'keyword')).toBe('/internships/');
  });

  it('maps city aliases to the site slug (Bengaluru -> bangalore)', () => {
    expect(resolveCity('Bengaluru')).toEqual({ slug: 'bangalore', keys: expect.arrayContaining(['bengaluru', 'bangalore']) });
    expect(resolveCity('New Delhi, India')?.slug).toBe('delhi');
    expect(resolveCity('Bangalore')?.keys).toEqual(expect.arrayContaining(['bangalore', 'bengaluru']));
    const plan = planSearch({ searchTerm: 'python', location: 'Bengaluru, Karnataka' }, DEFAULT_OPTIONS);
    expect(buildListingPath('job', plan.query, plan.strategy)).toBe('/jobs/python-jobs-in-bangalore/');
  });

  it('treats a country-only or remote-only location as no city', () => {
    expect(resolveCity('India')).toBeNull();
    expect(resolveCity('Remote')).toBeNull();
    expect(resolveCity('Work from home')).toBeNull();
    expect(resolveCity('')).toBeNull();
    expect(resolveCity(undefined)).toBeNull();
  });

  it('regression: never emits the pre-Spec-1706 path forms', () => {
    const inputs = [
      { searchTerm: 'python' },
      { searchTerm: 'python', location: 'Bangalore' },
      { searchTerm: 'data science', location: 'Pune, India' },
      { searchTerm: 'python', isRemote: true },
      { location: 'Mumbai' },
      { isRemote: true },
      { searchTerm: 'c++', location: 'Chennai' },
    ];
    for (const input of inputs) {
      const plan = planSearch(input, DEFAULT_OPTIONS);
      for (const kind of ['job', 'internship'] as const) {
        for (const strategy of ['narrow', 'keyword'] as const) {
          for (const page of [1, 2]) {
            const url = buildListingUrl(kind, plan.query, strategy, page);
            const p = url.replace('https://internshala.com', '');
            // the old `/jobs/<term>`, `/jobs/<term>-in-<city>` and `…/work-from-home` suffix forms
            expect(p).not.toMatch(/^\/(?:jobs|internships)\/(?:python|c)(?:\/|-in-|$)/);
            expect(p).not.toMatch(/\/work-from-home\/?$/);
            expect(p).not.toMatch(/\/work-from-home\//);
            if (/-in-/.test(p)) expect(p).toMatch(/[/-](?:jobs|internship)-in-[a-z0-9-]+\/(?:page-2\/)?$/);
            expect(p.endsWith('/')).toBe(true);
            expect(isRobotsSafeUrl(url)).toBe(true);
          }
        }
      }
    }
  });

  it('assertRobotsSafe refuses disallowed URLs and allows the four path families', () => {
    const bad = [
      'https://internshala.com/jobs/keywords-python/?page=2',
      'https://internshala.com/jobs/keywords-a,b/',
      'https://internshala.com/jobs/keywords-a%3Fb/',
      'https://internshala.com/jobs/keywords-a%3db/',
      'https://internshala.com/job/details/some-job123',
      'https://internshala.com/internship/details/some-internship123',
      'https://internshala.com/job/search/python',
      'https://internshala.com/internship/search/python',
      'https://internshala.com/api/jobs',
      'https://internshala.com/student/dashboard',
      'https://internshala.com/jobs/../api/x',
      'http://internshala.com/jobs/',
      'https://evil.example/jobs/',
      'https://internshala.com/about_us',
    ];
    for (const url of bad) {
      expect(isRobotsSafeUrl(url)).toBe(false);
      expect(() => assertRobotsSafe(url)).toThrow(/robots-disallowed/);
    }
    for (const url of [
      'https://internshala.com/jobs/',
      'https://internshala.com/internships/keywords-python/page-2/',
      'https://internshala.com/job/detail/network-administrator-job-in-lucknow-at-acme1789994794',
      'https://internshala.com/internship/detail/ai-research-internship-at-lumen1790260000',
    ]) {
      expect(() => assertRobotsSafe(url)).not.toThrow();
    }
  });

  it('a term the slug cannot represent uses the keyword strategy even with a city', () => {
    expect(planSearch({ searchTerm: 'c++', location: 'Chennai' }, DEFAULT_OPTIONS).strategy).toBe('keyword');
    expect(planSearch({ searchTerm: 'data science', location: 'Chennai' }, DEFAULT_OPTIONS).strategy).toBe('narrow');
    expect(planSearch({ searchTerm: 'python' }, DEFAULT_OPTIONS).strategy).toBe('keyword');
  });
});

describe('Spec 1706 / T2 — one parsed card per posting', () => {
  it('parses exactly one card per div.individual_internship (not 2x via .internship_meta)', () => {
    const $ = cheerio.load(fixture('jobs-page1.html'));
    expect($('div.individual_internship').length).toBe(4);
    expect($('.individual_internship, .internship_meta').length).toBe(8);
    expect(jobsPage.cardCount).toBe(4);
    expect(jobsPage.cards).toHaveLength(4);
    expect(new Set(jobsPage.cards.map((c) => c.internshipId)).size).toBe(4);
    expect(internshipsPage.cards).toHaveLength(5);
    expect(jobsPage.skipped).toEqual([]);
  });

  it('skips a card without a title or a detail link and reports why', () => {
    const html =
      '<div class="individual_internship" internshipId="1"><a class="job-title-href" href="/job/detail/x1">Kept</a></div>' +
      '<div class="individual_internship" internshipId="2"><h2 class="job-internship-name"></h2></div>' +
      '<div class="individual_internship" internshipId="3"><a class="job-title-href" href="/student/x">No link</a></div>';
    const page = parseListingPage(html, 'job');
    expect(page.cards.map((c) => c.title)).toEqual(['Kept']);
    expect(page.skipped).toEqual([
      { index: 1, reason: 'no title' },
      { index: 2, reason: 'no detail link for "No link"' },
    ]);
  });

  it('falls back to the pre-Spec-1706 containers without double counting nested ones', () => {
    const html =
      '<div class="individual_job" data-href="/job/detail/a1"><a class="job-title-href" href="/job/detail/a1">A</a>' +
      '<div class="job-listing-card"><a class="job-title-href" href="/job/detail/b1">nested</a></div></div>';
    const page = parseListingPage(html, 'job');
    expect(page.cards.map((c) => c.title)).toEqual(['A']);
  });
});

describe('Spec 1706 / T3 — ids', () => {
  it('uses is-<internshipId>, read through the lower-cased attribute', () => {
    expect(jobsPage.cards.map((c) => cardId(c))).toEqual(['is-3100001', 'is-3100002', 'is-3100003', 'is-3100004']);
  });

  it('falls back to the element id, then to the legacy url hash', () => {
    const fromElementId = parseListingPage(
      '<div class="individual_internship" id="individual_internship_42"><a class="job-title-href" href="/job/detail/x1">X</a></div>',
      'job',
    ).cards[0];
    expect(cardId(fromElementId)).toBe('is-42');
    const noId = parseListingPage(
      '<div class="individual_internship"><a class="job-title-href" href="/job/detail/x1">X</a></div>',
      'job',
    ).cards[0];
    expect(noId.internshipId).toBeNull();
    expect(cardId(noId)).toBe(`is-${Math.abs(hashCode('https://internshala.com/job/detail/x1'))}`);
  });

  it('INTERNSHALA_ID_SCHEME=url-hash restores the pre-Spec-1706 ids', () => {
    const card = jobCard('3100001');
    expect(cardId(card, 'url-hash')).toBe(`is-${Math.abs(hashCode(card.jobUrl))}`);
    expect(resolveInternshalaOptions({ INTERNSHALA_ID_SCHEME: 'url-hash' }).idScheme).toBe('url-hash');
  });
});

describe('Spec 1706 / T4 — locations and remote flags', () => {
  it('one <a> per city (jobs) -> one location each, India stamped', () => {
    const where = buildCardLocation(jobCard('3100002'));
    expect(where.locations.map((l) => l.city)).toEqual(['Ahmedabad', 'Delhi', 'Surat', 'Jaipur']);
    expect(where.locations.every((l) => l.country === Country.INDIA)).toBe(true);
    expect(where.location.country).toBe(Country.INDIA);
    expect(where.isRemote).toBe(false);
    expect(where.workFromHomeType).toBeNull();
  });

  it('one <a> with a comma list (internships) -> split into cities', () => {
    const card = internshipCard('3200003');
    expect(card.locationLabels).toEqual(['Chennai', 'Coimbatore', 'Madurai']);
    expect(buildCardLocation(card).locations).toHaveLength(3);
  });

  it('work from home -> remote, no "Work from home" city', () => {
    const card = jobCard('3100004');
    expect(card.remote).toBe(true);
    expect(card.locationLabels).toEqual([]);
    const where = buildCardLocation(card);
    expect(where.isRemote).toBe(true);
    expect(where.workFromHomeType).toBe('Remote');
    expect(where.locations).toEqual([]);
    expect(JSON.stringify(where)).not.toMatch(/work from home/i);
  });

  it('hybrid marker and office-days popover never leak into a city', () => {
    const card = internshipCard('3200003');
    expect(card.hybrid).toBe(true);
    const where = buildCardLocation(card);
    expect(where.workFromHomeType).toBe('Hybrid');
    expect(where.isRemote).toBe(false);
    for (const loc of [where.location, ...where.locations]) {
      expect(`${loc.city}`).not.toMatch(/hybrid|in-office|\(/i);
    }
  });

  it('an International card leaves the country null', () => {
    const where = buildCardLocation(jobCard('3100004'));
    expect(where.location.country).toBeNull();
    const intl = { ...jobCard('3100001'), international: true };
    expect(buildCardLocation(intl).locations[0]).toMatchObject({ city: 'Lucknow', country: null });
  });

  it('regression: "WFH" in an onsite card snippet does not make it remote', () => {
    const card = jobCard('3100001');
    expect(card.snippet).toMatch(/WFH/);
    expect(card.remote).toBe(false);
    expect(cardToJobPost(card, { nowMs: NOW }).isRemote).toBe(false);
  });
});

describe('Spec 1706 / T5 — INR pay', () => {
  it('reads a yearly job range from the period-bearing span', () => {
    expect(jobCard('3100001').compensation).toEqual({
      interval: CompensationInterval.YEARLY,
      minAmount: 200000,
      maxAmount: 260000,
      currency: 'INR',
    });
    expect(jobCard('3100001').payText).toBe('₹ 2,00,000 - 2,60,000 /year');
  });

  it('keeps a valid yearly INR range above 7 lakh', () => {
    expect(jobCard('3100004').compensation).toMatchObject({ minAmount: 480000, maxAmount: 1020000 });
  });

  it('a single amount gives min = max', () => {
    expect(parseInrPay('₹ 4,00,000 /year', 'job')).toMatchObject({
      minAmount: 400000,
      maxAmount: 400000,
      interval: CompensationInterval.YEARLY,
    });
  });

  it('no period: a job is yearly, an internship monthly', () => {
    expect(parseInrPay('₹ 2,00,000 - 2,60,000', 'job')?.interval).toBe(CompensationInterval.YEARLY);
    expect(parseInrPay('₹ 8,000', 'internship')?.interval).toBe(CompensationInterval.MONTHLY);
  });

  it('reads monthly stipends and a lump sum (interval null)', () => {
    expect(internshipCard('3200002').compensation).toMatchObject({
      minAmount: 4000,
      maxAmount: 7000,
      interval: CompensationInterval.MONTHLY,
    });
    expect(internshipCard('3200005').compensation).toMatchObject({ minAmount: 5000, maxAmount: 5000 });
    expect(internshipCard('3200004').compensation).toEqual({
      interval: null,
      minAmount: 3000,
      maxAmount: 7000,
      currency: 'INR',
    });
  });

  it('returns null for Competitive salary, Unpaid and junk', () => {
    expect(jobCard('3100003').compensation).toBeNull();
    expect(internshipCard('3200001').compensation).toBeNull();
    for (const text of ['Competitive salary', 'Unpaid', '', 'N/A', '₹ 7,000 - 3,000 /month', '₹ 0', null, undefined]) {
      expect(parseInrPay(text as string, 'job')).toBeNull();
    }
  });

  it('the post-internship offer (₹ 4.6LPA) never becomes the pay', () => {
    const card = internshipCard('3200003');
    expect(card.ppoText).toBe('Job offer upto ₹ 4.6LPA post internship');
    expect(card.compensation).toMatchObject({ minAmount: 11000, maxAmount: 23000, interval: CompensationInterval.MONTHLY });
  });

  it('reads other period spellings and an LPA pay span defensively', () => {
    expect(parseInrPay('₹ 25,000 per month', 'job')?.interval).toBe(CompensationInterval.MONTHLY);
    expect(parseInrPay('₹ 500 /day', 'internship')?.interval).toBe(CompensationInterval.DAILY);
    expect(parseInrPay('₹ 3 - 4.5 LPA', 'job')).toEqual({
      interval: CompensationInterval.YEARLY,
      minAmount: 300000,
      maxAmount: 450000,
      currency: 'INR',
    });
  });
});

describe('Spec 1706 / T6 — posted date', () => {
  it('parses the age buckets', () => {
    expect(parsePostedAge('Just now')).toEqual({ lowerH: 0, widthH: 24 });
    expect(parsePostedAge('Few hours ago')).toEqual({ lowerH: 0, widthH: 24 });
    expect(parsePostedAge('Today')).toEqual({ lowerH: 0, widthH: 24 });
    expect(parsePostedAge('5 hours ago')).toEqual({ lowerH: 5, widthH: 24 });
    expect(parsePostedAge('Yesterday')).toEqual({ lowerH: 24, widthH: 24 });
    expect(parsePostedAge('3 days ago')).toEqual({ lowerH: 72, widthH: 24 });
    expect(parsePostedAge('1 week ago')).toEqual({ lowerH: 168, widthH: 168 });
    expect(parsePostedAge('2 weeks ago')).toEqual({ lowerH: 336, widthH: 168 });
    expect(parsePostedAge('a month ago')).toEqual({ lowerH: 720, widthH: 720 });
    expect(parsePostedAge('30+ days ago')).toEqual({ lowerH: 720, widthH: 24 });
    for (const bad of ['Be an early applicant', '', null, undefined, 'in 3 days', 'x'.repeat(500)]) {
      expect(parsePostedAge(bad as string)).toBeNull();
    }
  });

  it('maps labels to YYYY-MM-DD (slug refinement off)', () => {
    const at = (label: string) => resolvePostedTime(label, '/job/detail/x', NOW, false).datePosted;
    expect(at('Today')).toBe('2026-09-24');
    expect(at('Few hours ago')).toBe('2026-09-24');
    expect(at('Just now')).toBe('2026-09-24');
    expect(at('3 days ago')).toBe('2026-09-21');
    expect(at('1 week ago')).toBe('2026-09-17');
    expect(at('Posted recently')).toBeNull();
    expect(resolvePostedTime('1 week ago', '/job/detail/x', NOW, false)).toEqual({
      datePosted: '2026-09-17',
      datePostedAt: null,
      datePostedPrecision: DatePostedPrecision.WEEK,
      datePostedBasis: DatePostedBasis.RELATIVE,
    });
  });

  it('a numeric hours label yields an hour-precision instant', () => {
    const posted = resolvePostedTime('5 hours ago', '/job/detail/x', NOW, false);
    expect(posted.datePosted).toBe('2026-09-24');
    expect(posted.datePostedPrecision).toBe(DatePostedPrecision.HOUR);
    expect(posted.datePostedAt).toBe('2026-09-24T14:46:00.000Z');
  });

  it('a slug epoch consistent with the label wins', () => {
    expect(slugEpochSeconds('/job/detail/network-administrator-job-in-lucknow-at-acme1789994794')).toBe(1789994794);
    const posted = resolvePostedTime('3 days ago', '/job/detail/acme1789994794', NOW, true);
    expect(posted).toEqual({
      datePosted: '2026-09-21',
      datePostedAt: '2026-09-21T12:46:34.000Z',
      datePostedPrecision: DatePostedPrecision.EXACT,
      datePostedBasis: DatePostedBasis.TIMESTAMP,
    });
  });

  it('an out-of-window slug epoch (or digits of a name) is ignored', () => {
    // "1 week ago" but the digits say 13 hours: outside [144, 504] h
    expect(resolvePostedTime('1 week ago', '/job/detail/x1790231497', NOW, true).datePosted).toBe('2026-09-17');
    // trailing digits that are not an epoch at all
    expect(resolvePostedTime('Today', '/job/detail/team-2000000001', NOW, true).datePosted).toBe('2026-09-24');
    expect(resolvePostedTime('Today', '/job/detail/team-2000000001', NOW, true).datePostedBasis).toBe(
      DatePostedBasis.RELATIVE,
    );
    expect(slugEpochSeconds('/job/detail/team-42')).toBeNull();
  });

  it('INTERNSHALA_SLUG_TIMESTAMP=false turns the refinement off', () => {
    expect(resolveInternshalaOptions({ INTERNSHALA_SLUG_TIMESTAMP: 'false' }).slugTimestamp).toBe(false);
    expect(resolveInternshalaOptions({}).slugTimestamp).toBe(true);
    const card = jobCard('3100001');
    expect(cardToJobPost(card, { nowMs: NOW, slugTimestamp: false }).datePostedBasis).toBe(DatePostedBasis.RELATIVE);
    expect(cardToJobPost(card, { nowMs: NOW }).datePostedBasis).toBe(DatePostedBasis.TIMESTAMP);
  });
});

describe('Spec 1706 / T7 — page signals and the canonical guard', () => {
  it('reads isLastPage, the max page and the canonical path', () => {
    expect(jobsPage.isLastPage).toBe(false);
    expect(jobsPage.maxPage).toBe(2);
    expect(jobsPage.canonicalPath).toBe('/jobs/keywords-python/');
    expect(internshipsPage.maxPage).toBe(3);
    const last = parseListingPage(fixture('jobs-page2-last.html'), 'job');
    expect(last.isLastPage).toBe(true);
    expect(last.canonicalPath).toBe('/jobs/keywords-python/');
    const empty = parseListingPage(fixture('empty-page.html'), 'internship');
    expect(empty.cards).toEqual([]);
    expect(empty.maxPage).toBeNull();
    expect(empty.looksBlocked).toBe(false);
  });

  it('normalises canonical paths (page-N/, case, encoding, trailing slash)', () => {
    expect(normaliseListingPath('https://internshala.com/Jobs/keywords-python/page-4/')).toBe('/jobs/keywords-python/');
    expect(normaliseListingPath('/internships/keywords-data%20science')).toBe('/internships/keywords-data science/');
    expect(normaliseListingPath('jobs/keywords-python/page-2/')).toBe('/jobs/keywords-python/');
    expect(normaliseListingPath('')).toBeNull();
    expect(normaliseListingPath(undefined)).toBeNull();
  });

  it('classifies the canonical against the request', () => {
    expect(classifyCanonical('/jobs/keywords-python/', 'https://internshala.com/jobs/keywords-python/')).toBe('match');
    expect(classifyCanonical('/jobs/python-jobs-in-bangalore/', 'https://internshala.com/jobs/')).toBe('dropped');
    expect(classifyCanonical('/jobs/keywords-python/', 'https://internshala.com/internships/')).toBe('dropped');
    expect(classifyCanonical('/jobs/', 'https://internshala.com/jobs/')).toBe('match');
    expect(classifyCanonical('/jobs/jobs-in-bengaluru/', '/jobs/jobs-in-bangalore/')).toBe('mismatch');
    expect(classifyCanonical('/jobs/keywords-python/', null)).toBe('absent');
  });

  it('flags a challenge page with no cards', () => {
    expect(parseListingPage(fixture('challenge.html'), 'job').looksBlocked).toBe(true);
  });
});

describe('Spec 1706 — card fields and the DTO', () => {
  it('maps a job card to a JobPostDto', () => {
    const job = cardToJobPost(jobCard('3100001'), { nowMs: NOW });
    expect(job).toMatchObject({
      id: 'is-3100001',
      title: 'Network Administrator',
      companyName: 'Acme Learning Group',
      jobUrl: 'https://internshala.com/job/detail/network-administrator-job-in-lucknow-at-acme-learning-group1789994794',
      companyLogo: 'https://uploads.example.com/logo/acme-learning.png',
      listingType: 'job',
      jobType: [JobType.FULL_TIME],
      skills: ['Python', 'DNS', 'Linux'],
      experienceRange: '1 year(s)',
      isRemote: false,
      workFromHomeType: null,
      datePosted: '2026-09-21',
      site: Site.INTERNSHALA,
    });
    expect(job.location).toMatchObject({ city: 'Lucknow', country: Country.INDIA });
    expect(job.description).toBe(
      'Key Responsibilities:\n1. Keep the campus network running.\n2. Script routine checks in Python.\n' +
        'Occasional WFH is possible after the probation period.\n\n' +
        'Salary: ₹ 2,00,000 - 2,60,000 /year | Experience: 1 year(s)',
    );
  });

  it('removes the hiring badge and the placeholder logo, absolutises a relative logo', () => {
    expect(jobCard('3100002').companyName).toBe('Gearbox Academy');
    expect(jobCard('3100002').companyLogo).toBeNull();
    expect(internshipCard('3200004').companyLogo).toBe('https://internshala.com/uploads/logo/tidewater.png');
  });

  it('skills are null when the card lists none; the "+N more" chip is ignored', () => {
    expect(cardToJobPost(jobCard('3100003'), { nowMs: NOW }).skills).toBeNull();
    expect(jobCard('3100001').skills).not.toContain('+2 more');
  });

  it('sets listingType and jobType from the card', () => {
    expect(cardJobTypes(internshipCard('3200001'))).toEqual([JobType.INTERNSHIP, JobType.PART_TIME]);
    expect(cardJobTypes(internshipCard('3200002'))).toEqual([JobType.INTERNSHIP]);
    const partTimeJob = parseListingPage(fixture('jobs-page2-last.html'), 'job').cards[0];
    expect(cardJobTypes(partTimeJob)).toEqual([JobType.PART_TIME]);
    expect(cardToJobPost(internshipCard('3200002'), { nowMs: NOW }).listingType).toBe('internship');
  });

  it('builds the internship extras line with the stipend, duration and offer', () => {
    expect(composeDescription(null, internshipCard('3200001'))).toBe(
      'Stipend: Unpaid | Duration: 1 Month | Job offer post internship',
    );
    expect(composeDescription('Body', internshipCard('3200003'))).toBe(
      'Body\n\nStipend: ₹ 11,000 - 23,000 /month | Duration: 3 Months | Job offer upto ₹ 4.6LPA post internship',
    );
  });

  it('keeps the apply-by deadline when a card shows one, and adds nothing when it does not', () => {
    const html =
      '<div class="container-fluid individual_internship" internshipid="3900001" employment_type="internship">' +
      '<h3 class="job-internship-name"><a class="job-title-href" href="/internship/detail/x-internship-at-example3900001">X</a></h3>' +
      '<div class="apply_by"><div class="item_body">15 Oct\' 26</div></div></div>';
    const card = parseListingPage(html, 'internship').cards[0];
    expect(card.applyBy).toBe("15 Oct' 26");
    expect(composeDescription('Body', card)).toBe("Body\n\nApply by: 15 Oct' 26");
    // Today's fixture cards carry no deadline element: the extras line is unchanged.
    expect(internshipCard('3200001').applyBy).toBeNull();
  });

  it('extracts emails from the description, falling back to the snippet', () => {
    const card = internshipCard('3200004');
    expect(cardToJobPost(card, { nowMs: NOW }).emails).toEqual(['careers@example.org']);
    expect(cardToJobPost(card, { nowMs: NOW, description: 'Detail body without an address' }).emails).toEqual([
      'careers@example.org',
    ]);
  });

  it('keeps the snippet line breaks and collapses blank-line runs', () => {
    expect(normaliseSnippet('  a  \n\n\n  b\n   \n')).toBe('a\n\nb');
    expect(normaliseSnippet('   ')).toBeNull();
    expect(internshipCard('3200004').snippet).toBe('Analyse survey data with Pandas.\n\nQuestions: careers@example.org');
  });

  it('accepts only board-host detail paths and strips query and fragment', () => {
    expect(toDetailPath('/job/detail/x-1?referral=list#top')).toBe('/job/detail/x-1');
    expect(toDetailPath('https://internshala.com/internship/detail/y-2')).toBe('/internship/detail/y-2');
    expect(toDetailPath('https://evil.example/job/detail/x')).toBeNull();
    expect(toDetailPath('javascript:alert(1)')).toBeNull();
    expect(toDetailPath('/job/details/x')).toBeNull();
    expect(toDetailPath('')).toBeNull();
  });
});

describe('Spec 1706 — filters, plan, options, merge, detail body', () => {
  it('filters on remote, city (with aliases), part time and age', () => {
    const cards = [...jobsPage.cards, ...internshipsPage.cards];
    const ids = (filters: Partial<CardFilters>) =>
      cards.filter((c) => cardMatchesFilters(c, { ...NO_FILTERS, ...filters })).map((c) => c.internshipId);
    expect(ids({ remote: true })).toEqual(['3100004', '3200001', '3200002']);
    expect(ids({ cityKeys: resolveCity('Bangalore')!.keys })).toEqual(['3100003', '3200005']);
    expect(ids({ cityKeys: resolveCity('Chennai')!.keys })).toEqual(['3200003', '3200004']);
    expect(ids({ partTime: 'only' })).toEqual(['3200001']);
    expect(ids({ partTime: 'exclude' })).not.toContain('3200001');
    // '2 days ago' (lower bound 48 h) is kept; '3 days ago' and '1 week ago' are dropped
    expect(ids({ maxAgeHours: 48 })).toEqual(['3100003', '3100004', '3200001', '3200002', '3200003', '3200004']);
  });

  it('maps jobType to streams and filters', () => {
    expect(planSearch({}, DEFAULT_OPTIONS).kinds).toEqual(['internship', 'job']);
    expect(planSearch({ jobType: JobType.INTERNSHIP }, DEFAULT_OPTIONS).kinds).toEqual(['internship']);
    expect(planSearch({ jobType: JobType.FULL_TIME }, DEFAULT_OPTIONS)).toMatchObject({
      kinds: ['job'],
      filters: { partTime: 'exclude' },
    });
    expect(planSearch({ jobType: JobType.PART_TIME }, DEFAULT_OPTIONS)).toMatchObject({
      kinds: ['internship', 'job'],
      filters: { partTime: 'only' },
    });
    expect(planSearch({ jobType: JobType.CONTRACT }, DEFAULT_OPTIONS)).toMatchObject({
      kinds: [],
      unsupportedJobType: 'contract',
    });
    expect(planSearch({}, { ...DEFAULT_OPTIONS, defaultStreams: 'job' }).kinds).toEqual(['job']);
  });

  it('plans paging, depth and the remote/city interplay', () => {
    const plan = planSearch({ resultsWanted: 6, offset: 2, descriptionDepth: 'board', hoursOld: 48 }, DEFAULT_OPTIONS);
    expect(plan).toMatchObject({ resultsWanted: 6, offset: 2, need: 8, depth: 'board', detailBudget: 0 });
    expect(plan.filters.maxAgeHours).toBe(48);
    expect(planSearch({}, DEFAULT_OPTIONS)).toMatchObject({ resultsWanted: 15, need: 15, depth: 'detail-25', detailBudget: 25 });
    expect(planSearch({ descriptionDepth: 'detail-all' }, DEFAULT_OPTIONS).detailBudget).toBe(100);
    const remote = planSearch({ isRemote: true, location: 'Pune' }, DEFAULT_OPTIONS);
    expect(remote.query).toEqual({ term: '', city: null, remote: true });
    expect(remote.filters.cityKeys).toBeNull();
    expect(planSearch({ location: 'India' }, DEFAULT_OPTIONS).strategy).toBe('keyword');
  });

  it('resolves the environment switches with safe fallbacks', () => {
    expect(resolveInternshalaOptions({})).toEqual(DEFAULT_OPTIONS);
    expect(resolveInternshalaOptions({ INTERNSHALA_DEFAULT_STREAMS: 'jobs' }).defaultStreams).toBe('job');
    expect(resolveInternshalaOptions({ INTERNSHALA_DEFAULT_STREAMS: 'internship' }).defaultStreams).toBe('internship');
    expect(resolveInternshalaOptions({ INTERNSHALA_DEFAULT_STREAMS: 'bogus' }).defaultStreams).toBe('both');
    expect(resolveInternshalaOptions({ INTERNSHALA_MAX_PAGES: '3' }).maxPages).toBe(3);
    expect(resolveInternshalaOptions({ INTERNSHALA_MAX_PAGES: '0' }).maxPages).toBe(10);
    expect(resolveInternshalaOptions({ INTERNSHALA_MAX_PAGES: '500' }).maxPages).toBe(10);
    expect(resolveInternshalaOptions({ INTERNSHALA_MAX_PAGES: 'x' }).maxPages).toBe(10);
  });

  it('interleaves streams round-robin', () => {
    expect(interleave([[1, 3, 5, 7], [2, 4]])).toEqual([1, 2, 3, 4, 5, 7]);
    expect(interleave([[], ['a']])).toEqual(['a']);
  });

  it('reads the first detail container as Markdown or plain text', () => {
    const md = parseDetailDescription(fixture('detail.html'), DescriptionFormat.MARKDOWN)!;
    expect(md).toContain('Acme Learning Group runs twelve campuses');
    expect(md).toMatch(/[-*]\s+Keep the campus network running/);
    expect(md).not.toContain('Second container');
    const plain = parseDetailDescription(fixture('detail.html'), DescriptionFormat.PLAIN)!;
    expect(plain).toContain('Script routine checks in Python');
    expect(plain).not.toContain('<li>');
    expect(parseDetailDescription('<html><body>nothing</body></html>')).toBeNull();
  });
});
