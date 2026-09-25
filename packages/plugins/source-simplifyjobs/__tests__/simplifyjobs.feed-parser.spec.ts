import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';
import * as vm from 'vm';
import {
  compactRow,
  FeedArrayScanner,
  parseFeedBody,
  SimplifyFeedFormatError,
  StringInterner,
} from '../src/simplifyjobs.feed-parser';
import { SimplifyRow } from '../src/simplifyjobs.types';

const FIXTURES = path.join(__dirname, 'fixtures');
const NEWGRAD_TEXT = fs.readFileSync(path.join(FIXTURES, 'newgrad-listings.json'), 'utf8');
const INTERNSHIPS_TEXT = fs.readFileSync(path.join(FIXTURES, 'internships-listings.json'), 'utf8');

function scanAll(chunks: Buffer[]): { objects: unknown[]; skipped: number } {
  const objects: unknown[] = [];
  const scanner = new FeedArrayScanner((json) => objects.push(JSON.parse(json)));
  for (const chunk of chunks) scanner.push(chunk);
  scanner.end();
  return { objects, skipped: scanner.skipped };
}

function chunked(buf: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

function liveRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'example-row-author',
    category: 'Software',
    company_name: 'Acme Robotics',
    id: '11111111-2222-4333-8444-555555555555',
    title: 'Software Engineer',
    active: true,
    terms: ['Summer 2027'],
    date_updated: 1790262470,
    date_posted: 1790208000,
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    locations: ['Austin, TX'],
    company_url: 'https://simplify.jobs/c/Acme-Robotics',
    is_visible: true,
    sponsorship: 'Other',
    degrees: ["Bachelor's"],
    ...overrides,
  };
}

describe('FeedArrayScanner (Spec 1694)', () => {
  const TRICKY = Buffer.from(
    JSON.stringify([
      { a: 'brace } and bracket ] and quote " and backslash \\', b: ['x', ']'] },
      { nested: { deep: [1, { two: '}' }] }, unicode: 'Montréal – café € 😀' },
      { escaped: 'ends with a backslash\\' },
    ]),
    'utf8',
  );

  it('splits an array into its object elements', () => {
    const { objects, skipped } = scanAll([TRICKY]);
    expect(objects).toEqual(JSON.parse(TRICKY.toString('utf8')));
    expect(skipped).toBe(0);
  });

  it.each([1, 2, 3, 5, 7, 64])('gives the same elements when fed in %i-byte chunks (mid-string, mid-escape, mid-UTF-8)', (size) => {
    expect(scanAll(chunked(TRICKY, size)).objects).toEqual(JSON.parse(TRICKY.toString('utf8')));
  });

  it('handles a pretty-printed feed split into odd chunks', () => {
    const buf = Buffer.from(NEWGRAD_TEXT, 'utf8');
    const expected = JSON.parse(NEWGRAD_TEXT);
    expect(scanAll(chunked(buf, 97)).objects).toEqual(expected);
    expect(scanAll(chunked(buf, 4096)).objects).toEqual(expected);
  });

  it('tolerates a UTF-8 byte order mark and surrounding whitespace', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('  \n[ {"a":1} ]\n ')]);
    expect(scanAll([buf]).objects).toEqual([{ a: 1 }]);
  });

  it('skips and counts non-object elements', () => {
    const { objects, skipped } = scanAll([Buffer.from('[1, "a [ string", [2, {"n":1}], {"x":1}, true, null, -3.5e2]')]);
    expect(objects).toEqual([{ x: 1 }]);
    expect(skipped).toBe(6);
  });

  it('accepts an empty array', () => {
    expect(scanAll([Buffer.from('[]')]).objects).toEqual([]);
  });

  it.each([
    ['an empty body', ''],
    ['whitespace only', '  \n '],
    ['an object instead of an array', '{"message":"Not Found"}'],
    ['an HTML error page', '<html>oops</html>'],
    ['a truncated body', '[{"a":1},{"b":'],
    ['a body without its closing bracket', '[{"a":1}'],
    ['data after the closing bracket', '[{"a":1}] {"b":2}'],
    ['unbalanced brackets', '[{"a":1}}'],
  ])('rejects %s', (_label, text) => {
    expect(() => scanAll([Buffer.from(text)])).toThrow(SimplifyFeedFormatError);
  });

  it('rejects an element larger than the per-element cap, in one chunk or many', () => {
    const big = Buffer.from(`[{"a":"${'x'.repeat(200)}"}]`);
    const single = new FeedArrayScanner(() => undefined, { maxElementBytes: 100 });
    expect(() => single.push(big)).toThrow(/element exceeds 100 bytes/);
    const many = new FeedArrayScanner(() => undefined, { maxElementBytes: 100 });
    expect(() => chunked(big, 16).forEach((c) => many.push(c))).toThrow(/element exceeds 100 bytes/);
  });

  it('rejects a body larger than the total cap', () => {
    const scanner = new FeedArrayScanner(() => undefined, { maxTotalBytes: 10 });
    expect(() => scanner.push(Buffer.from('[{"a":1},{"b":2}]'))).toThrow(/body exceeds 10 bytes/);
  });
});

describe('compactRow (Spec 1694)', () => {
  const intern = () => new StringInterner();

  it('keeps only the mapped fields: no source handle, no degrees', () => {
    const row = compactRow(liveRow(), 'internships', intern());
    expect(row).toEqual<SimplifyRow>({
      id: '11111111-2222-4333-8444-555555555555',
      feed: 'internships',
      title: 'Software Engineer',
      companyName: 'Acme Robotics',
      companyUrl: 'https://simplify.jobs/c/Acme-Robotics',
      category: 'Software',
      terms: ['Summer 2027'],
      datePosted: 1790208000,
      dateUpdated: 1790262470,
      url: 'https://boards.greenhouse.io/acme/jobs/1',
      locations: ['Austin, TX'],
      sponsorship: null,
    });
    expect(Object.keys(row as object)).not.toEqual(expect.arrayContaining(['source']));
    expect(JSON.stringify(row)).not.toContain('example-row-author');
    expect(JSON.stringify(row)).not.toContain("Bachelor's");
  });

  it.each([
    ['inactive', { active: false }],
    ['active as a string', { active: 'true' }],
    ['hidden', { is_visible: false }],
    ['no url', { url: undefined }],
    ['a blank url', { url: '   ' }],
    ['a relative url', { url: '/jobs/1' }],
    ['a javascript: url', { url: 'javascript:alert(1)' }],
    ['no title', { title: '' }],
    ['a non-string title', { title: 42 }],
    ['no company', { company_name: '  ' }],
  ])('drops a row with %s', (_label, overrides) => {
    expect(compactRow(liveRow(overrides), 'newgrad', intern())).toBeNull();
  });

  it('drops non-object elements', () => {
    for (const value of [null, 1, 'x', [liveRow()]]) {
      expect(compactRow(value, 'newgrad', intern())).toBeNull();
    }
  });

  it('keeps a row with no is_visible key', () => {
    const raw = liveRow();
    delete raw.is_visible;
    expect(compactRow(raw, 'newgrad', intern())).not.toBeNull();
  });

  it('removes N/A terms and trims labels', () => {
    const row = compactRow(
      liveRow({ terms: ['N/A', ' Winter 2027 ', 'n/a', ''], locations: ['  Toronto,  ON, Canada ', '', 7] }),
      'internships',
      intern(),
    );
    expect(row?.terms).toEqual(['Winter 2027']);
    expect(row?.locations).toEqual(['Toronto, ON, Canada']);
  });

  it('drops a company page that is not on simplify.jobs', () => {
    expect(compactRow(liveRow({ company_url: 'https://evil.example/c/Acme' }), 'newgrad', intern())?.companyUrl).toBeNull();
    expect(compactRow(liveRow({ company_url: 42 }), 'newgrad', intern())?.companyUrl).toBeNull();
  });

  it('reads epoch seconds, converts a millisecond value, and nulls junk', () => {
    expect(compactRow(liveRow({ date_posted: 1790208000123 }), 'newgrad', intern())?.datePosted).toBe(1790208000);
    expect(compactRow(liveRow({ date_posted: '1790208000' }), 'newgrad', intern())?.datePosted).toBeNull();
    expect(compactRow(liveRow({ date_posted: -5 }), 'newgrad', intern())?.datePosted).toBeNull();
    expect(compactRow(liveRow({ date_updated: undefined }), 'newgrad', intern())?.dateUpdated).toBeNull();
  });

  it('derives a stable UUID-shaped id from the apply URL when the row has none', () => {
    const a = compactRow(liveRow({ id: undefined }), 'newgrad', intern());
    const b = compactRow(liveRow({ id: '../weird id' }), 'newgrad', intern());
    expect(a?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(b?.id).toBe(a?.id);
  });

  it('normalises category and sponsorship while compacting', () => {
    const row = compactRow(
      liveRow({ category: 'Data Science, AI & Machine Learning', sponsorship: 'Offers Sponsorship' }),
      'newgrad',
      intern(),
    );
    expect(row?.category).toBe('AI/ML/Data');
    expect(row?.sponsorship).toBe('offered');
  });

  it('shares identical location and term lists between rows', () => {
    const shared = intern();
    const a = compactRow(liveRow({ url: 'https://example.com/a' }), 'internships', shared);
    const b = compactRow(liveRow({ url: 'https://example.com/b' }), 'internships', shared);
    expect(a?.locations).toBe(b?.locations);
    expect(a?.terms).toBe(b?.terms);
    expect(Object.isFrozen(a?.locations)).toBe(true);
  });
});

describe('parseFeedBody (Spec 1694)', () => {
  it('parses the new-grad fixture into live rows, newest first', () => {
    const parsed = parseFeedBody(NEWGRAD_TEXT, 'newgrad');
    expect(parsed.total).toBe(19);
    // inactive, hidden, blank url, blank title and blank company are dropped
    expect(parsed.rows).toHaveLength(14);
    const ids = parsed.rows.map((r) => r.id.slice(-3));
    expect(ids).toEqual(['101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '114', '115', '118', '119']);
    expect(parsed.rows.every((r) => r.feed === 'newgrad' && r.terms.length === 0)).toBe(true);
    expect(parsed.newestPosted).toBe(1790280000 - 3 * 3600);
  });

  it('accepts the body as a Buffer, an ArrayBuffer, a typed array or a string alike', () => {
    const fromString = parseFeedBody(INTERNSHIPS_TEXT, 'internships').rows;
    const buf = Buffer.from(INTERNSHIPS_TEXT, 'utf8');
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    expect(parseFeedBody(buf, 'internships').rows).toEqual(fromString);
    expect(parseFeedBody(arrayBuffer, 'internships').rows).toEqual(fromString);
    expect(parseFeedBody(new Uint8Array(buf), 'internships').rows).toEqual(fromString);
    expect(fromString).toHaveLength(9);
  });

  it('breaks date ties on date_updated, then id', () => {
    const body = JSON.stringify([
      liveRow({ id: 'b', url: 'https://example.com/1', date_updated: 5 }),
      liveRow({ id: 'a', url: 'https://example.com/2', date_updated: 5 }),
      liveRow({ id: 'c', url: 'https://example.com/3', date_updated: 9 }),
      liveRow({ id: 'd', url: 'https://example.com/4', date_posted: undefined }),
    ]);
    expect(parseFeedBody(body, 'internships').rows.map((r) => r.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('rejects a body that is not a JSON array of objects', () => {
    expect(() => parseFeedBody('{"rows":[]}', 'newgrad')).toThrow(SimplifyFeedFormatError);
    expect(() => parseFeedBody('[{"a":1},{"b":oops}]', 'newgrad')).toThrow(/element 2 is not valid JSON/);
    expect(() => parseFeedBody(null, 'newgrad')).toThrow(/unexpected body type null/);
    expect(() => parseFeedBody(42, 'newgrad')).toThrow(/unexpected body type number/);
  });

  it('never decodes or parses more than one element at a time', () => {
    const rows = Array.from({ length: 400 }, (_, i) => liveRow({ id: `r${i}`, url: `https://example.com/jobs/${i}` }));
    const body = Buffer.from(JSON.stringify(rows, null, 4), 'utf8');
    const toStringSpy = jest.spyOn(Buffer.prototype, 'toString');
    const parseSpy = jest.spyOn(JSON, 'parse');
    try {
      const parsed = parseFeedBody(body, 'internships');
      expect(parsed.rows).toHaveLength(400);
      const longestDecoded = Math.max(0, ...toStringSpy.mock.results.map((r) => String(r.value).length));
      const longestParsed = Math.max(0, ...parseSpy.mock.calls.map((c) => String(c[0]).length));
      expect(body.length).toBeGreaterThan(100_000);
      expect(longestDecoded).toBeLessThan(2_000);
      expect(longestParsed).toBeLessThan(2_000);
    } finally {
      toStringSpy.mockRestore();
      parseSpy.mockRestore();
    }
  });
});

describe('compacted cache footprint (Spec 1694, heap budget)', () => {
  function exposeGc(): () => void {
    v8.setFlagsFromString('--expose-gc');
    return vm.runInNewContext('gc') as () => void;
  }

  /** A feed shaped like production: ~20k rows, ~8k of them live, realistic string lengths and repetition. */
  function productionShapedFeed(live: number, inactive: number): Buffer {
    const companies = Array.from({ length: 900 }, (_, i) => `Company Number ${i} Incorporated`);
    const cities = Array.from({ length: 1500 }, (_, i) => `City ${i}, ${['TX', 'CA', 'NY', 'WA', 'MA'][i % 5]}`);
    const categories = ['Software', 'AI/ML/Data', 'Quant', 'Hardware', 'Product'];
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < live + inactive; i++) {
      const c = i % companies.length;
      rows.push({
        source: 'Simplify',
        category: categories[i % categories.length],
        company_name: companies[c],
        id: `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`,
        title: `Software Engineer Intern, Platform Infrastructure Team ${i}`,
        active: i < live,
        terms: ['Summer 2027'],
        date_updated: 1790262470 - i,
        date_posted: 1790208000 - (i % 60) * 86400,
        url: `https://company${c}.wd5.myworkdayjobs.com/en-US/External_Careers/job/City-${i % 1500}/Software-Engineer-Intern_R${1000000 + i}`,
        locations: i % 7 === 0 ? [cities[i % 1500], cities[(i + 1) % 1500], cities[(i + 2) % 1500]] : [cities[i % 1500]],
        company_url: `https://simplify.jobs/c/Company-Number-${c}`,
        is_visible: true,
        sponsorship: 'Other',
        degrees: ["Bachelor's", "Master's"],
      });
    }
    return Buffer.from(JSON.stringify(rows, null, 4), 'utf8');
  }

  it('holds 8k live rows (of a ~20k-row, ~15 MB feed) in under 6 MB of heap', () => {
    const gc = exposeGc();
    const body = productionShapedFeed(8000, 12000);
    expect(body.length).toBeGreaterThan(12 * 1024 * 1024);

    gc();
    const before = process.memoryUsage().heapUsed;
    let rows: SimplifyRow[] | null = parseFeedBody(body, 'internships').rows;
    gc();
    const after = process.memoryUsage().heapUsed;

    expect(rows).toHaveLength(8000);
    const retained = after - before;
    // Measured ~3.8 MB on Node 24. A whole-body JSON.parse of the same feed
    // retains ~16 MB of parse tree, on top of the ~15 MB body string.
    expect(retained).toBeLessThan(6 * 1024 * 1024);
    rows = null;
  });
});
