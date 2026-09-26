import 'reflect-metadata';
import { CompensationInterval, DescriptionFormat, JobType, Site } from '@ever-jobs/models';
import {
  ApolloCache,
  collectListings,
  experienceRange,
  extractNextData,
  findSearchConnection,
  getApolloData,
  isRemoteLocation,
  jobUrlFor,
  listingSearchText,
  locationSlug,
  looksLikeWellfoundChallenge,
  mapListing,
  markdownToBasicHtml,
  matchesAllTerms,
  matchesPlace,
  parseNextDataJson,
  parseWellfoundCompensation,
  planRoutes,
  resolveRef,
  roleConfirmed,
  roleSlug,
  sizeToEmployees,
  stripMarkdown,
  termTokens,
  WellfoundListingPair,
  WellfoundNextData,
} from '../src';
import { htmlPage, landingPayload, loadJsonFixture, readFixture } from './fixtures/builders';

/** Spec 1708: pure parsing, mapping and routing for the Wellfound aggregator search. */

const roleLocation = (): WellfoundNextData => loadJsonFixture<WellfoundNextData>('role-location.p1.json');
const roleRemote = (): WellfoundNextData => loadJsonFixture<WellfoundNextData>('role-remote.p2.json');
const feed = (): WellfoundNextData => loadJsonFixture<WellfoundNextData>('jobs-feed.json');
const dataOf = (nd: WellfoundNextData): ApolloCache => getApolloData(nd) as ApolloCache;

function pairById(data: ApolloCache, id: string): WellfoundListingPair {
  const pair = collectListings(data).find((p) => String(p.listing.id) === id);
  if (!pair) throw new Error(`listing ${id} not in fixture`);
  return pair;
}

describe('extractNextData', () => {
  const nd = { page: '/x', props: { pageProps: { apolloState: { data: { a: { __typename: 'T' } } } } } };

  it('reads the payload whatever the attribute order', () => {
    const idFirst = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd)}</script>`;
    const typeFirst = `<script type="application/json" id="__NEXT_DATA__" nonce="abc">${JSON.stringify(nd)}</script>`;
    expect(extractNextData(`<html>${idFirst}</html>`)).toEqual(nd);
    expect(extractNextData(`<html>${typeFirst}</html>`)).toEqual(nd);
  });

  it('returns null for a page without the script, broken JSON, or a non-object', () => {
    expect(extractNextData('<html><body>nothing here</body></html>')).toBeNull();
    expect(extractNextData('<script id="__NEXT_DATA__">{"page":</script>')).toBeNull();
    expect(extractNextData('<script id="__NEXT_DATA__">[1,2]</script>')).toBeNull();
    expect(extractNextData('')).toBeNull();
    expect(extractNextData(null)).toBeNull();
    expect(parseNextDataJson('   ')).toBeNull();
  });

  it('reads a full synthetic page that also carries the CDN beacon', () => {
    const html = htmlPage(roleLocation(), { beacon: true });
    expect(extractNextData(html)?.page).toBe('/seoLanding/roleLocationSearch');
  });

  it('getApolloData returns null when the payload has no Apollo cache', () => {
    expect(getApolloData({ page: '/x', props: { pageProps: {} } })).toBeNull();
    expect(getApolloData(null)).toBeNull();
  });
});

describe('collectListings (regression: the old deep-array search returned [] on this shape)', () => {
  it('returns every listing of a role/location page, each with its company', () => {
    const pairs = collectListings(dataOf(roleLocation()), 1);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs).toHaveLength(7);
    expect(pairs.every((p) => p.startup !== null)).toBe(true);
  });

  it('follows connection.startups[i].highlightedJobListings[j], not object-key order', () => {
    const ids = collectListings(dataOf(roleLocation()), 1).map((p) => p.listing.id);
    // Object order puts 800031 first; the connection ranks company 900001 first.
    expect(ids).toEqual(['800011', '800021', '800022', '800023', '800031', '800032', '800033']);
  });

  it('links each listing to the company that highlights it', () => {
    const data = dataOf(roleLocation());
    expect(pairById(data, '800011').startup?.name).toBe('Harborlight Analytics');
    expect(pairById(data, '800033').startup?.name).toBe('Brightfern Health');
  });

  it('reads the remote landing page (24-listing shape trimmed to 5)', () => {
    const pairs = collectListings(dataOf(roleRemote()), 2);
    expect(pairs.map((p) => p.listing.id)).toEqual(['810011', '810012', '810021', '810031', '810032']);
  });

  it('falls back to company nodes and listing.startup refs when there is no connection (/jobs feed)', () => {
    const pairs = collectListings(dataOf(feed()));
    expect(pairs.map((p) => p.listing.id)).toEqual(['820011', '820012']);
    expect(pairs.every((p) => p.startup?.name === 'Saltmarsh Energy')).toBe(true);
    // A {__ref} remote config is resolved through the cache.
    expect(pairs[0].remoteConfig?.kind).toBe('REMOTE');
  });

  it('de-duplicates a listing highlighted twice and ignores dangling refs', () => {
    const nd = landingPayload({ startups: [{ id: '1', listings: ['a1', 'a2'] }, { id: '2', listings: ['a2', 'a3'] }] });
    const data = dataOf(nd as WellfoundNextData);
    (data['StartupResult:2'].highlightedJobListings as unknown[]).push({ __ref: 'JobListingSearchResult:missing' });
    expect(collectListings(data).map((p) => p.listing.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('returns [] for a missing cache', () => {
    expect(collectListings(null)).toEqual([]);
  });
});

describe('findSearchConnection', () => {
  it('reads the counts whatever the argument order inside the key', () => {
    const p1 = findSearchConnection(dataOf(roleLocation()), 1);
    expect(p1).toMatchObject({ pageCount: 3, perPage: 20, totalJobCount: 131 });
    const p2 = findSearchConnection(dataOf(roleRemote()), 2);
    expect(p2).toMatchObject({ pageCount: 45, perPage: 20, totalJobCount: 1204 });
  });

  it('prefers the connection whose page argument matches', () => {
    const data = dataOf(landingPayload({ page: 1, pageCount: 4, startups: [{ id: '1', listings: ['x'] }] }) as WellfoundNextData);
    const talent = (data.ROOT_QUERY as Record<string, Record<string, unknown>>).talent;
    talent['seoLandingPageJobSearchResults({"page":2,"role":"software-engineer"})'] = { pageCount: 99, startups: [] };
    expect(findSearchConnection(data, 2)?.pageCount).toBe(99);
    expect(findSearchConnection(data, 1)?.pageCount).toBe(4);
  });

  it('returns null without ROOT_QUERY or a connection', () => {
    expect(findSearchConnection(dataOf(feed()))).toBeNull();
    expect(findSearchConnection({})).toBeNull();
  });
});

describe('resolveRef', () => {
  it('only resolves own keys of the cache', () => {
    const data: ApolloCache = { 'A:1': { __typename: 'A', id: '1' } };
    expect(resolveRef(data, { __ref: 'A:1' })).toEqual({ __typename: 'A', id: '1' });
    expect(resolveRef(data, { __ref: '__proto__' })).toBeNull();
    expect(resolveRef(data, { __ref: 'constructor' })).toBeNull();
    expect(resolveRef(data, { kind: 'REMOTE' })).toEqual({ kind: 'REMOTE' });
    expect(resolveRef(data, null)).toBeNull();
  });
});

describe('mapListing', () => {
  const data = dataOf(roleLocation());

  it('builds jobUrl as /jobs/{id}-{slug} (regression: the id prefix was dropped)', () => {
    const job = mapListing(pairById(data, '800011'))!;
    expect(job.jobUrl).toBe('https://wellfound.com/jobs/800011-associate-software-engineer');
    expect(job.id).toBe('wellfound-800011');
    expect(job.site).toBe(Site.WELLFOUND);
  });

  it('maps the company from the StartupResult node', () => {
    const job = mapListing(pairById(data, '800011'))!;
    expect(job.companyName).toBe('Harborlight Analytics');
    expect(job.companyUrl).toBe('https://wellfound.com/company/harborlight-analytics');
    expect(job.companyLogo).toBe('https://example.invalid/logos/harborlight.png');
    expect(job.companyDescription).toBe('Tide tables for your data warehouse');
    expect(job.companyNumEmployees).toBe('51-200');
  });

  it('reads liveStartAt as epoch seconds (regression: not 1970-01-21)', () => {
    const job = mapListing(pairById(data, '800011'))!;
    expect(job.datePosted).toBe('2026-09-22');
    expect(job.datePostedAt).toBe('2026-09-22T20:11:46.000Z');
    expect(job.datePostedPrecision).toBe('exact');
    expect(job.datePostedBasis).toBe('timestamp');
  });

  it('maps locations: empty list → null, two names → two entries', () => {
    expect(mapListing(pairById(data, '800033'))!.location).toBeNull();
    expect(mapListing(pairById(data, '800033'))!.locations).toBeUndefined();
    const multi = mapListing(pairById(data, '800021'))!;
    expect(multi.locations).toHaveLength(2);
    expect(multi.location).not.toBeNull();
  });

  it('maps job type, department, experience and emails', () => {
    const job = mapListing(pairById(data, '800021'))!;
    expect(job.jobType).toEqual([JobType.FULL_TIME]);
    expect(job.employmentType).toBe('full-time');
    expect(job.department).toBe('Backend Engineer');
    expect(job.experienceRange).toBe('3-5 years');
    expect(mapListing(pairById(data, '800031'))!.experienceRange).toBe('8+ years');
    expect(mapListing(pairById(data, '800011'))!.emails).toEqual(['jobs@harborlight.example']);
  });

  it('never sets atsType/atsId from atsSource', () => {
    const job = mapListing(pairById(data, '800011'))!;
    expect(job.atsType).toBeUndefined();
    expect(job.atsId).toBeUndefined();
  });

  it('returns null for a listing without id or title', () => {
    expect(mapListing({ listing: { id: '1', title: '  ' }, startup: null, remoteConfig: null })).toBeNull();
    expect(mapListing({ listing: { id: '', title: 'X' }, startup: null, remoteConfig: null })).toBeNull();
  });

  it('keeps the pre-Spec-1708 fields as fallbacks', () => {
    const job = mapListing({
      listing: {
        id: 42,
        title: 'Legacy Role',
        slug: 'legacy-role',
        company: { name: 'Oldco', slug: 'oldco', logoUrl: 'https://example.invalid/old.png', companySize: 'SIZE_1_10' },
        compensation: { min: 100000, max: 120000, currency: 'EUR' },
        locations: ['Berlin, Germany'],
        skills: ['go', 'sql'],
        createdAt: '2026-01-05T10:00:00Z',
      },
      startup: null,
      remoteConfig: null,
    })!;
    expect(job.companyName).toBe('Oldco');
    expect(job.companyUrl).toBe('https://wellfound.com/company/oldco');
    expect(job.companyNumEmployees).toBe('1-10');
    expect(job.compensation).toMatchObject({ minAmount: 100000, maxAmount: 120000, currency: 'EUR', interval: 'yearly' });
    expect(job.location?.city).toBe('Berlin');
    expect(job.skills).toEqual(['go', 'sql']);
    expect(job.datePosted).toBe('2026-01-05');
  });

  it('WELLFOUND_JOB_URL_STYLE=slug shape is still available', () => {
    expect(jobUrlFor('7', 'role-x', 'slug')).toBe('https://wellfound.com/jobs/role-x');
    expect(jobUrlFor('7', null, 'slug')).toBe('https://wellfound.com/jobs/7');
    expect(jobUrlFor('7', null)).toBe('https://wellfound.com/jobs/7');
    expect(mapListing(pairById(data, '800011'), { jobUrlStyle: 'slug' })!.jobUrl).toBe(
      'https://wellfound.com/jobs/associate-software-engineer',
    );
  });
});

describe('remote mapping', () => {
  const data = dataOf(roleLocation());
  const remoteData = dataOf(roleRemote());

  it('inline REMOTE → remote, "Remote"', () => {
    const job = mapListing(pairById(data, '800032'))!;
    expect(job.isRemote).toBe(true);
    expect(job.workFromHomeType).toBe('Remote');
  });

  it('ONSITE_OR_REMOTE → "Hybrid or Remote"', () => {
    expect(mapListing(pairById(data, '800021'))!.workFromHomeType).toBe('Hybrid or Remote');
  });

  it('ONSITE with wfhFlexible → "Hybrid"; the site remote flag alone is not enough to say Remote', () => {
    const onsite = mapListing(pairById(data, '800031'))!;
    expect(onsite.workFromHomeType).toBe('Hybrid');
    expect(onsite.isRemote).toBe(false);
    const flagged = mapListing(pairById(remoteData, '810031'))!;
    expect(flagged.isRemote).toBe(true);
    expect(flagged.workFromHomeType).toBe('Hybrid');
  });

  it('a {__ref} remote config resolves through the cache', () => {
    const [first] = collectListings(dataOf(feed()));
    const job = mapListing(first)!;
    expect(job.isRemote).toBe(true);
    expect(job.workFromHomeType).toBe('Remote');
  });

  it('remote:true with remoteConfig:null → remote', () => {
    expect(mapListing(pairById(remoteData, '810011'))!.isRemote).toBe(true);
  });

  it('locationNames ["Remote"] → remote', () => {
    const job = mapListing({
      listing: { id: '1', title: 'X', locationNames: ['Remote'], remote: false, remoteConfig: null },
      startup: null,
      remoteConfig: null,
    })!;
    expect(job.isRemote).toBe(true);
  });

  it('a plain onsite listing is not remote', () => {
    const job = mapListing(pairById(data, '800011'))!;
    expect(job.isRemote).toBe(false);
  });
});

describe('parseWellfoundCompensation', () => {
  it.each([
    ['$139k – $153k', 139000, 153000, 'USD', CompensationInterval.YEARLY],
    ['$130k – $210k • 0.05% – 0.2%', 130000, 210000, 'USD', CompensationInterval.YEARLY],
    ['$175k – $225k • No equity', 175000, 225000, 'USD', CompensationInterval.YEARLY],
    ['$126k – $187k CAD', 126000, 187000, 'CAD', CompensationInterval.YEARLY],
    ['€60k – €80k', 60000, 80000, 'EUR', CompensationInterval.YEARLY],
    ['£45k - £55k', 45000, 55000, 'GBP', CompensationInterval.YEARLY],
    ['C$90k – C$110k', 90000, 110000, 'CAD', CompensationInterval.YEARLY],
    ['$1.2M – $1.5M', 1200000, 1500000, 'USD', CompensationInterval.YEARLY],
    ['$50 – $70 /hr', 50, 70, 'USD', CompensationInterval.HOURLY],
    ['$4,000 – $6,000 /mo', 4000, 6000, 'USD', CompensationInterval.MONTHLY],
    ['120k – 150k', 120000, 150000, 'USD', CompensationInterval.YEARLY],
  ])('%s', (raw, min, max, currency, interval) => {
    expect(parseWellfoundCompensation(raw)).toMatchObject({ minAmount: min, maxAmount: max, currency, interval });
  });

  it('a single bound gives min only', () => {
    const c = parseWellfoundCompensation('$120k');
    expect(c).toMatchObject({ minAmount: 120000, currency: 'USD' });
    expect(c?.maxAmount).toBeUndefined();
  });

  it('scales each bound by its own suffix', () => {
    expect(parseWellfoundCompensation('$900k – $1.1M')).toMatchObject({ minAmount: 900000, maxAmount: 1100000 });
  });

  it.each([[''], ['   '], [null], [undefined], ['Equity Only • 0.5% – 1.0%'], ['0.5% – 1.0%'], ['Competitive']])(
    '%p → null',
    (raw) => {
      expect(parseWellfoundCompensation(raw)).toBeNull();
    },
  );

  it('an unknown trailing word is not taken as a currency', () => {
    expect(parseWellfoundCompensation('$120k – $150k OTE')?.currency).toBe('USD');
  });
});

describe('size and experience', () => {
  it.each([
    ['SIZE_1_10', '1-10'],
    ['SIZE_51_200', '51-200'],
    ['SIZE_1001_5000', '1001-5000'],
    ['SIZE_10001_PLUS', '10001+'],
    ['BIG', null],
    [null, null],
  ])('%p → %p', (size, expected) => {
    expect(sizeToEmployees(size)).toBe(expected);
  });

  it('experience ranges', () => {
    expect(experienceRange(3, 5)).toBe('3-5 years');
    expect(experienceRange(3, 3)).toBe('3 years');
    expect(experienceRange(3, null)).toBe('3+ years');
    expect(experienceRange(null, 5)).toBe('up to 5 years');
    expect(experienceRange(null, null)).toBeNull();
    expect(experienceRange(-1, 'x')).toBeNull();
  });
});

describe('description formats', () => {
  const md = '**Location**\n\nHybrid in *San Francisco*.\n\n#### Perks\n\n- Health\n- [Handbook](https://example.invalid/h?a=1&b=2)\n- [bad](javascript:alert(1))\n\n<script>alert(1)</script>';
  const pair = (description: string): WellfoundListingPair => ({
    listing: { id: '1', title: 'X', description },
    startup: null,
    remoteConfig: null,
  });

  it('MARKDOWN returns the body unchanged (regression: turndown escaped it to \\*\\*)', () => {
    const job = mapListing(pair(md), { format: DescriptionFormat.MARKDOWN })!;
    expect(job.description).toBe(md);
    expect(job.description).not.toContain('\\*');
    expect(job.description).toContain('\n\n');
  });

  it('an unset format is Markdown too', () => {
    expect(mapListing(pair(md))!.description).toBe(md);
  });

  it('PLAIN strips the Markdown syntax', () => {
    const plain = mapListing(pair(md), { format: DescriptionFormat.PLAIN })!.description!;
    expect(plain).not.toContain('**');
    expect(plain).not.toMatch(/^#/m);
    expect(plain).not.toMatch(/\[[^\]]*\]\([^)]*\)/);
    expect(plain).toContain('Location');
    expect(plain).toContain('Handbook');
    expect(plain).toContain('• Health');
  });

  it('HTML escapes source markup and renders a safe subset', () => {
    const html = mapListing(pair(md), { format: DescriptionFormat.HTML })!.description!;
    expect(html).toContain('<strong>Location</strong>');
    expect(html).toContain('<em>San Francisco</em>');
    expect(html).toContain('<h4>Perks</h4>');
    expect(html).toContain('<ul><li>Health</li>');
    expect(html).toContain('<a href="https://example.invalid/h?a=1&amp;b=2">Handbook</a>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:alert(1)">');
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it('markdownToBasicHtml handles ordered lists, rules and backslash escapes', () => {
    expect(markdownToBasicHtml('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(markdownToBasicHtml('a\n\n---\n\nb')).toBe('<p>a</p>\n<hr>\n<p>b</p>');
    expect(markdownToBasicHtml('5 \\* 3 \\> 2')).toBe('<p>5 * 3 &gt; 2</p>');
    expect(markdownToBasicHtml('')).toBe('');
  });

  it('only http(s) links become anchors', () => {
    expect(markdownToBasicHtml('[x](javascript:void0) [y](data:text/html;base64,AAAA) [z](http://example.invalid)')).toBe(
      '<p>x y <a href="http://example.invalid">z</a></p>',
    );
  });

  it('stripMarkdown keeps escaped characters and snake_case words', () => {
    expect(stripMarkdown('use \\*args and my_var_name')).toBe('use *args and my_var_name');
    expect(stripMarkdown('## Title ##\n\n> quoted _em_ `code`')).toBe('Title\n\nquoted em code');
  });

  it('the /jobs feed HTML snippet goes through the HTML converters', () => {
    const [first] = collectListings(dataOf(feed()));
    expect(mapListing(first, { format: DescriptionFormat.HTML })!.description).toBe(
      '<p>Tune <strong>turbine</strong> controllers.</p>',
    );
    expect(mapListing(first, { format: DescriptionFormat.MARKDOWN })!.description).toBe('Tune **turbine** controllers.');
    expect(mapListing(first, { format: DescriptionFormat.PLAIN })!.description).toBe('Tune turbine controllers.');
  });

  it('WELLFOUND_DESCRIPTION_SOURCE=html keeps the pre-Spec-1708 reading', () => {
    const legacy = { descriptionSource: 'html' as const };
    expect(mapListing(pair(md), { ...legacy, format: DescriptionFormat.HTML })!.description).toBe(md);
    expect(mapListing(pair('<p>a <b>b</b></p>'), { ...legacy, format: DescriptionFormat.MARKDOWN })!.description).toBe('a **b**');
    expect(mapListing(pair('<p>a <b>b</b></p>'), legacy)!.description).toBe('a b');
  });
});

describe('routing (planRoutes)', () => {
  const urls = (input: Parameters<typeof planRoutes>[0], mode?: 'landing' | 'feed') =>
    planRoutes(input, mode).map((a) => a.url(1));

  it.each([
    [{ searchTerm: 'Software Engineer', isRemote: true }, ['https://wellfound.com/role/r/software-engineer', 'https://wellfound.com/jobs']],
    [
      { searchTerm: 'Software Engineer', location: 'San Francisco, CA' },
      [
        'https://wellfound.com/role/l/software-engineer/san-francisco',
        'https://wellfound.com/role/software-engineer',
        'https://wellfound.com/location/san-francisco',
      ],
    ],
    [{ searchTerm: 'Full Stack Engineer' }, ['https://wellfound.com/role/full-stack-engineer', 'https://wellfound.com/jobs']],
    [{ location: 'Berlin' }, ['https://wellfound.com/location/berlin', 'https://wellfound.com/jobs']],
    [{}, ['https://wellfound.com/jobs']],
  ])('%p', (input, expected) => {
    expect(urls(input)).toEqual(expected);
  });

  it('never produces q=, /search, role= or jobId= (regression: q= was sent and ignored)', () => {
    const inputs = [
      { searchTerm: 'data scientist' },
      { searchTerm: 'swe', location: 'Austin' },
      { searchTerm: 'go', isRemote: true, location: 'Remote' },
      { location: 'Paris' },
      {},
    ];
    for (const input of inputs) {
      for (const mode of ['landing', 'feed'] as const) {
        for (const attempt of planRoutes(input, mode)) {
          for (const page of [1, 2]) {
            const url = attempt.url(page);
            expect(url).not.toMatch(/[?&]q=|\/search|[?&]role=|[?&]jobId=/);
            expect(url.startsWith('https://wellfound.com/')).toBe(true);
          }
        }
      }
    }
  });

  it('never builds /role/l/{role} without a location', () => {
    for (const input of [{ searchTerm: 'x' }, { searchTerm: 'x', location: '' }, { searchTerm: 'x', location: 'Remote' }]) {
      expect(urls(input).some((u) => /\/role\/l\/[^/]+$/.test(u))).toBe(false);
    }
  });

  it('page N >= 2 appends ?page=N', () => {
    const [first] = planRoutes({ searchTerm: 'software engineer' });
    expect(first.url(1)).toBe('https://wellfound.com/role/software-engineer');
    expect(first.url(3)).toBe('https://wellfound.com/role/software-engineer?page=3');
  });

  it('"Remote" as a location means isRemote', () => {
    expect(isRemoteLocation('Remote')).toBe(true);
    expect(isRemoteLocation('remote, US')).toBe(true);
    expect(locationSlug('Remote')).toBeNull();
    expect(urls({ searchTerm: 'software engineer', location: 'Remote' })[0]).toBe(
      'https://wellfound.com/role/r/software-engineer',
    );
  });

  it('slugs', () => {
    expect(roleSlug('Software Engineer')).toBe('software-engineer');
    expect(roleSlug('  R&D   Engineer ')).toBe('r-and-d-engineer');
    expect(roleSlug('Développeur')).toBe('developpeur');
    expect(roleSlug('SWE')).toBe('software-engineer');
    expect(roleSlug('ML Engineer')).toBe('machine-learning-engineer');
    expect(roleSlug('+++')).toBeNull();
    expect(locationSlug('San Francisco, CA')).toBe('san-francisco');
    expect(locationSlug('New York City')).toBe('new-york-city');
  });

  it('fallback routes filter locally for what the site no longer filters', () => {
    const [roleLoc, roleOnly, locOnly] = planRoutes({ searchTerm: 'Software Engineer', location: 'San Francisco, CA' });
    expect(roleLoc.filters).toEqual({ term: null, location: null, remote: false });
    expect(roleOnly.filters).toEqual({ term: null, location: 'san francisco', remote: false });
    expect(locOnly.filters).toEqual({ term: 'Software Engineer', location: null, remote: false });
    const [remote, remoteFeed] = planRoutes({ searchTerm: 'Software Engineer', isRemote: true, location: 'Denver' });
    expect(remote.filters).toEqual({ term: null, location: 'denver', remote: false });
    expect(remoteFeed.filters).toEqual({ term: 'Software Engineer', location: 'denver', remote: true });
    expect(planRoutes({ location: 'Berlin', isRemote: true })[0].filters.remote).toBe(true);
  });

  it('feed mode (the pre-Spec-1708 entry point) only reads /jobs and filters locally', () => {
    const plan = planRoutes({ searchTerm: 'Rust', location: 'Lisbon' }, 'feed');
    expect(plan.map((a) => a.url(1))).toEqual(['https://wellfound.com/jobs']);
    expect(plan[0].filters).toEqual({ term: 'Rust', location: 'lisbon', remote: false });
  });

  it('"C++ Developer" keeps its c++ token for filtering', () => {
    expect(termTokens('C++ Developer')).toEqual(['c++', 'developer']);
    expect(termTokens('C developer, a b')).toEqual(['c', 'developer']);
    expect(termTokens('c# / .net')).toEqual(['c#', 'net']);
  });
});

describe('local filters', () => {
  it('matchesAllTerms requires every token', () => {
    expect(matchesAllTerms('Backend Engineer', 'rust backend')).toBe(false);
    expect(matchesAllTerms('Senior Rust Backend Engineer', 'rust backend')).toBe(true);
    expect(matchesAllTerms('anything', '')).toBe(true);
  });

  it('matches at word starts; short tokens must be whole words', () => {
    expect(matchesAllTerms('Engineering Manager', 'engineer')).toBe(true);
    expect(matchesAllTerms('Trust and Safety', 'rust')).toBe(false);
    expect(matchesAllTerms('Google Ads specialist', 'go')).toBe(false);
    expect(matchesAllTerms('Go developer', 'go')).toBe(true);
    expect(matchesAllTerms('Cloud engineer', 'c developer')).toBe(false);
    expect(matchesAllTerms('C++ developer', 'c++ developer')).toBe(true);
    expect(matchesAllTerms('Embedded C developer', 'c developer')).toBe(true);
  });

  it('the searched text covers titles, company and description', () => {
    const data = dataOf(roleLocation());
    const pair = pairById(data, '800021');
    const haystack = listingSearchText(pair);
    expect(matchesAllTerms(haystack, 'quillstone')).toBe(true);
    expect(matchesAllTerms(haystack, 'control plane')).toBe(true);
    const [feedFirst] = collectListings(dataOf(feed()));
    expect(matchesAllTerms(listingSearchText(feedFirst), 'turbine')).toBe(true);
    expect(matchesAllTerms(listingSearchText(feedFirst), 'strong')).toBe(false);
  });

  it('matchesPlace looks at location names and accepted remote regions', () => {
    const data = dataOf(roleLocation());
    expect(matchesPlace(pairById(data, '800021').listing, 'new york')).toBe(true);
    expect(matchesPlace(pairById(data, '800033').listing, 'united states')).toBe(true);
    expect(matchesPlace(pairById(data, '800011').listing, 'toronto')).toBe(false);
    expect(matchesPlace(pairById(data, '800011').listing, null)).toBe(true);
  });
});

describe('challenge detection and role confirmation', () => {
  it('a normal page with the CDN beacon is not a challenge (regression)', () => {
    expect(looksLikeWellfoundChallenge(htmlPage(roleLocation(), { beacon: true }))).toBe(false);
    expect(looksLikeWellfoundChallenge(readFixture('cdn-beacon.snippet.html'))).toBe(false);
  });

  it('a real interstitial is a challenge', () => {
    expect(looksLikeWellfoundChallenge(readFixture('interstitial.synthetic.html'))).toBe(true);
    expect(looksLikeWellfoundChallenge('')).toBe(false);
  });

  it('roleConfirmed reads SeoRoleKeyword, then query.role', () => {
    const nd = roleLocation();
    expect(roleConfirmed(nd, dataOf(nd), 'software-engineer')).toBe(true);
    expect(roleConfirmed(nd, dataOf(nd), 'rust-engineer')).toBe(false);
    const bare = landingPayload({ role: 'data-scientist', roleKeyword: null, startups: [] }) as WellfoundNextData;
    expect(roleConfirmed(bare, dataOf(bare), 'data-scientist')).toBe(true);
    expect(roleConfirmed({ ...bare, query: {} }, dataOf(bare), 'data-scientist')).toBe(false);
  });
});
