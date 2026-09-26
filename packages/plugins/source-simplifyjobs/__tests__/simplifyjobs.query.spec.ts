import { JobType } from '@ever-jobs/models';
import {
  buildLocationQuery,
  compareRows,
  dedupByUrl,
  foldText,
  includesAtWordStart,
  isFreshEnough,
  locationFactsOf,
  LocationFactsMemo,
  matchesLocation,
  matchesSearch,
  mergeSorted,
  resolvePaging,
  routeJobType,
  selectPage,
  selectRows,
  SimplifyFilter,
  tokenizeSearchTerm,
  urlKey,
} from '../src/simplifyjobs.query';
import { SimplifyRow } from '../src/simplifyjobs.types';

const MIDNIGHT_S = Date.UTC(2026, 8, 24) / 1000;
const NOW_S = MIDNIGHT_S + 20 * 3600; // 20:00 UTC

let seq = 0;
function row(overrides: Partial<SimplifyRow> = {}): SimplifyRow {
  seq++;
  return {
    id: `id-${String(seq).padStart(4, '0')}`,
    feed: 'internships',
    title: 'Software Engineering Intern',
    companyName: 'Acme Robotics',
    companyUrl: null,
    category: 'Software',
    terms: ['Summer 2027'],
    datePosted: MIDNIGHT_S,
    dateUpdated: MIDNIGHT_S,
    url: `https://example.com/jobs/${seq}`,
    locations: ['Austin, TX'],
    sponsorship: null,
    ...overrides,
  };
}

describe('routeJobType (Spec 1694)', () => {
  it('reads both lists when no job type is given', () => {
    for (const jobType of [undefined, null, '']) {
      expect(routeJobType(jobType)).toEqual({ feeds: ['newgrad', 'internships'], summerOnly: false });
    }
  });

  it('routes internships, summer and full-time to one list each', () => {
    expect(routeJobType(JobType.INTERNSHIP)).toEqual({ feeds: ['internships'], summerOnly: false });
    expect(routeJobType(JobType.SUMMER)).toEqual({ feeds: ['internships'], summerOnly: true });
    expect(routeJobType(JobType.FULL_TIME)).toEqual({ feeds: ['newgrad'], summerOnly: false });
  });

  it.each([
    JobType.PART_TIME,
    JobType.CONTRACT,
    JobType.TEMPORARY,
    JobType.PER_DIEM,
    JobType.NIGHTS,
    JobType.VOLUNTEER,
    JobType.OTHER,
    JobType.PERMANENT,
    JobType.APPRENTICESHIP,
    'no-such-type',
  ])('routes %s to neither list', (jobType) => {
    expect(routeJobType(jobType)).toBeNull();
  });
});

describe('search matching (Spec 1694)', () => {
  it('folds case and accents', () => {
    expect(foldText('Développeur CAFÉ')).toBe('developpeur cafe');
    expect(foldText('plain')).toBe('plain');
  });

  it('matches only at the start of a word', () => {
    expect(includesAtWordStart('quantitative finance', 'quant')).toBe(true);
    expect(includesAtWordStart('software internship', 'intern')).toBe(true);
    expect(includesAtWordStart('milwaukee, wi', 'uk')).toBe(false);
    expect(includesAtWordStart('london, uk', 'uk')).toBe(true);
    expect(includesAtWordStart('asp.net developer', '.net')).toBe(true);
    expect(includesAtWordStart('anything', '')).toBe(true);
  });

  it('tokenises on whitespace, keeps quoted phrases, strips edge punctuation', () => {
    expect(tokenizeSearchTerm('  Software   INTERN ')).toEqual(['software', 'intern']);
    expect(tokenizeSearchTerm('"machine learning" intern')).toEqual(['machine learning', 'intern']);
    expect(tokenizeSearchTerm('(c++), c#;')).toEqual(['c++', 'c#']);
    expect(tokenizeSearchTerm('Café')).toEqual(['cafe']);
    expect(tokenizeSearchTerm('')).toEqual([]);
    expect(tokenizeSearchTerm(undefined)).toEqual([]);
    expect(tokenizeSearchTerm(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '))).toHaveLength(16);
  });

  it('requires every token across title, company, category and terms', () => {
    const r = row({ title: 'Software Engineering Intern', companyName: 'Nvidia', category: 'Quant', terms: ['Summer 2027'] });
    expect(matchesSearch(r, tokenizeSearchTerm('software intern'))).toBe(true);
    expect(matchesSearch(r, tokenizeSearchTerm('quant'))).toBe(true);
    expect(matchesSearch(r, tokenizeSearchTerm('summer 2027'))).toBe(true);
    expect(matchesSearch(r, tokenizeSearchTerm('nvidia'))).toBe(true);
    expect(matchesSearch(r, tokenizeSearchTerm('software hardware'))).toBe(false);
    expect(matchesSearch(r, tokenizeSearchTerm('"engineering intern"'))).toBe(true);
    expect(matchesSearch(r, tokenizeSearchTerm('"intern engineering"'))).toBe(false);
    expect(matchesSearch(r, [])).toBe(true);
  });

  it('does not search locations', () => {
    expect(matchesSearch(row({ locations: ['Austin, TX'] }), tokenizeSearchTerm('austin'))).toBe(false);
  });
});

describe('location matching (Spec 1694)', () => {
  const memo = new LocationFactsMemo(1000);
  const matches = (labels: string[], query: string): boolean => {
    const q = buildLocationQuery(query);
    if (!q) throw new Error('no query');
    return matchesLocation({ locations: labels }, q, memo);
  };

  it.each([
    [['NYC'], 'New York'],
    [['NYC'], 'new york, ny'],
    [['London, UK'], 'United Kingdom'],
    [['London, UK'], 'UK'],
    [['London, UK'], 'London'],
    [['London, ON'], 'Canada'],
    [['London, ON'], 'Ontario'],
    [['Toronto, ON, Canada'], 'Toronto, Canada'],
    [['Kanata, Ottawa, ON, Canada'], 'Ottawa'],
    [['Kanata, Ottawa, ON, Canada'], 'Kanata'],
    [['Austin, TX'], 'USA'],
    [['Austin, TX'], 'United States'],
    [['San Francisco, CA'], 'California'],
    [['Remote in USA'], 'Remote'],
    [['Remote in USA'], 'United States'],
    [['Montréal, QC, Canada'], 'montreal'],
    [['Austin, TX', 'London, UK'], 'London'],
  ])('%j matches %j', (labels, query) => {
    expect(matches(labels, query)).toBe(true);
  });

  it.each([
    [['Milwaukee, WI'], 'UK'],
    [['London, UK'], 'Canada'],
    [['London, ON'], 'United Kingdom'],
    [['Austin, TX'], 'Toronto, Canada'],
    [['Austin, TX'], 'Remote'],
    [['Toronto, ON, Canada'], 'USA'],
    [['Houston, TX'], 'Austin'],
  ])('%j does not match %j', (labels, query) => {
    expect(matches(labels, query)).toBe(false);
  });

  it('ignores a blank or missing query', () => {
    expect(buildLocationQuery('   ')).toBeNull();
    expect(buildLocationQuery(undefined)).toBeNull();
  });

  it('infers a country from a state or province code for filtering', () => {
    expect(locationFactsOf('London, ON').countries).toEqual(['Canada']);
    expect(locationFactsOf('Cambridge, MA').countries).toEqual(['United States']);
    expect(locationFactsOf('Remote in USA')).toMatchObject({ countries: ['United States'], remote: true });
  });

  it('memoises facts per label and stays within its cap', () => {
    const small = new LocationFactsMemo(2);
    const first = small.get('Austin, TX');
    expect(small.get('Austin, TX')).toBe(first);
    small.get('Boston, MA');
    small.get('Denver, CO');
    expect(small.size).toBeLessThanOrEqual(2);
  });
});

describe('freshness (Spec 1694)', () => {
  it('keeps a row posted exactly at the cut-off and drops one a second earlier', () => {
    const cutoff = NOW_S - 3 * 3600;
    expect(isFreshEnough({ datePosted: cutoff }, cutoff)).toBe(true);
    expect(isFreshEnough({ datePosted: cutoff + 1 }, cutoff)).toBe(true);
    expect(isFreshEnough({ datePosted: cutoff - 1 }, cutoff)).toBe(false);
  });

  it('counts a midnight-aligned row as posted at the end of its day', () => {
    const cutoff12h = NOW_S - 12 * 3600; // 08:00 today
    expect(isFreshEnough({ datePosted: MIDNIGHT_S }, cutoff12h)).toBe(true);
    expect(isFreshEnough({ datePosted: MIDNIGHT_S - 86400 }, cutoff12h)).toBe(false);
    const cutoff21h = NOW_S - 21 * 3600; // 23:00 yesterday
    expect(isFreshEnough({ datePosted: MIDNIGHT_S - 86400 }, cutoff21h)).toBe(true);
    // the same instant NOT midnight-aligned is exact, so it is dropped
    expect(isFreshEnough({ datePosted: MIDNIGHT_S + 1 }, cutoff12h)).toBe(false);
  });

  it('keeps undated rows', () => {
    expect(isFreshEnough({ datePosted: null }, NOW_S)).toBe(true);
  });
});

describe('ordering, merging and dedup (Spec 1694)', () => {
  it('orders newest first, then by date_updated, then by id; undated last', () => {
    const a = row({ id: 'a', datePosted: 10, dateUpdated: 1 });
    const b = row({ id: 'b', datePosted: 10, dateUpdated: 1 });
    const c = row({ id: 'c', datePosted: 10, dateUpdated: 5 });
    const d = row({ id: 'd', datePosted: 20, dateUpdated: 0 });
    const e = row({ id: 'e', datePosted: null, dateUpdated: null });
    expect([e, b, a, c, d].sort(compareRows).map((r) => r.id)).toEqual(['d', 'c', 'a', 'b', 'e']);
  });

  it('merges sorted lists into one sorted list', () => {
    const ng = [row({ datePosted: 50 }), row({ datePosted: 30 }), row({ datePosted: 10 })];
    const interns = [row({ datePosted: 40 }), row({ datePosted: 20 })];
    expect(mergeSorted([ng, interns]).map((r) => r.datePosted)).toEqual([50, 40, 30, 20, 10]);
    expect(mergeSorted([[], interns])).toEqual(interns);
    expect(mergeSorted([[], []])).toEqual([]);
  });

  it('normalises apply URLs for dedup: trim, host case, one trailing slash', () => {
    expect(urlKey(' https://Acme.WD5.MyWorkdayJobs.com/Careers/Job/X/ ')).toBe('https://acme.wd5.myworkdayjobs.com/Careers/Job/X');
    expect(urlKey('https://example.com/a?b=C')).toBe('https://example.com/a?b=C');
  });

  it('keeps the first (newest) row per URL and every distinct requisition', () => {
    const newest = row({ url: 'https://Example.com/x/', datePosted: 9 });
    const older = row({ url: 'https://example.com/x', datePosted: 5 });
    const sameTitleOtherReq = row({ url: 'https://example.com/y', datePosted: 4 });
    expect(dedupByUrl([newest, older, sameTitleOtherReq])).toEqual([newest, sameTitleOtherReq]);
  });
});

describe('selectPage (Spec 1694)', () => {
  const memo = new LocationFactsMemo(1000);
  const noFilter: SimplifyFilter = { tokens: [], location: null, remoteOnly: false, cutoffSeconds: null, summerOnly: false };
  // Two pre-sorted lists with ties, an in-list repeat and a cross-list repeat.
  const newgrad = [
    row({ id: 'n1', datePosted: 90, url: 'https://example.com/a' }),
    row({ id: 'n2', datePosted: 70, url: 'https://example.com/b', title: 'Hardware Engineer' }),
    row({ id: 'n3', datePosted: 70, url: 'https://example.com/c' }),
    row({ id: 'n4', datePosted: 50, url: 'https://Example.com/a/' }),
    row({ id: 'n5', datePosted: 10, url: 'https://example.com/e' }),
  ];
  const interns = [
    row({ id: 'i1', datePosted: 80, url: 'https://EXAMPLE.com/c/' }),
    row({ id: 'i2', datePosted: 70, url: 'https://example.com/f', title: 'Hardware Intern' }),
    row({ id: 'i3', datePosted: 30, url: 'https://example.com/g' }),
    row({ id: 'i4', datePosted: null, url: 'https://example.com/h' }),
  ];

  it.each([
    [noFilter],
    [{ ...noFilter, tokens: ['hardware'] }],
    [{ ...noFilter, tokens: ['nothing-matches'] }],
  ])('returns exactly selectRows(...).slice(offset, offset + limit) for every page (%#)', (filter) => {
    const all = selectRows([newgrad, interns], filter, memo).map((r) => r.id);
    for (let offset = 0; offset <= all.length + 1; offset++) {
      for (let limit = 1; limit <= all.length + 1; limit++) {
        const page = selectPage([newgrad, interns], filter, memo, offset, limit);
        expect(page.rows.map((r) => r.id)).toEqual(all.slice(offset, offset + limit));
      }
    }
  });

  it('stops as soon as the page is full', () => {
    const calls: string[] = [];
    const counting: SimplifyFilter = { ...noFilter, cutoffSeconds: 0 };
    const spyRows = [newgrad, interns].map((list) =>
      list.map((r) => new Proxy(r, { get: (t, p) => (p === 'datePosted' && calls.push(t.id), Reflect.get(t, p)) })),
    );
    const page = selectPage(spyRows, counting, memo, 0, 2);
    expect(page.rows.map((r) => r.id)).toEqual(['n1', 'i1']);
    expect(page.exhausted).toBe(false);
    // the two heads, then each list's next head: 4 of the 9 rows
    expect([...new Set(calls)].sort()).toEqual(['i1', 'i2', 'n1', 'n2']);
  });

  it('reports the full count once every row is examined', () => {
    const page = selectPage([newgrad, interns], noFilter, memo, 0, 100);
    expect(page).toMatchObject({ matched: 7, exhausted: true });
  });
});

describe('resolvePaging (Spec 1694)', () => {
  it('applies offset and clamps resultsWanted to [1, 1000]', () => {
    expect(resolvePaging(0, 15)).toEqual({ offset: 0, limit: 15 });
    expect(resolvePaging(7.9, 5000)).toEqual({ offset: 7, limit: 1000 });
    expect(resolvePaging(-3, 0)).toEqual({ offset: 0, limit: 1 });
    expect(resolvePaging(undefined, undefined)).toEqual({ offset: 0, limit: 25 });
    expect(resolvePaging(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ offset: 0, limit: 25 });
  });
});
