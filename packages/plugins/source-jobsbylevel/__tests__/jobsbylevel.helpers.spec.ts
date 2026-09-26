import * as fs from 'fs';
import * as path from 'path';
import { CompensationInterval } from '@ever-jobs/models';
import {
  aiLevelFromPageHtml,
  aiLevelFromScore,
  buildCompensation,
  buildLocationLabel,
  buildLocationMatcher,
  detailBudgetFor,
  humaniseSlug,
  isAllowedJobsByLevelUrl,
  isTruthyFlag,
  JobsByLevelResponseError,
  mergeSkills,
  normaliseCountryCode,
  normaliseLocationText,
  parseDetailPage,
  parseMcpToolPayload,
  parseRssFeed,
  resolveAiLevel,
  slugFromJobUrl,
  splitTitleCompany,
} from '../src/jobsbylevel.helpers';
import {
  JobsByLevelTtlCache,
  reserveJobsByLevelSlot,
  resetJobsByLevelState,
} from '../src/jobsbylevel.state';

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function diagnosticsOf(fn: () => unknown): { reason: string; detail?: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof JobsByLevelResponseError) return { ...err.diagnostics };
    throw err;
  }
  throw new Error('expected a JobsByLevelResponseError');
}

describe('jobsbylevel helpers — Spec 1693', () => {
  describe('AI level', () => {
    it.each([
      [0, 1],
      [39, 1],
      [40, 2],
      [59, 2],
      [60, 3],
      [79, 3],
      [80, 4],
      [100, 4],
      ['85', 4],
      [39.5, 1],
    ])('score %p is level %p', (score, level) => {
      expect(aiLevelFromScore(score)).toBe(level);
    });

    it.each([null, undefined, 'abc', '', -1, 101, Number.NaN, {}])('score %p gives null', (score) => {
      expect(aiLevelFromScore(score)).toBeNull();
    });

    it('prefers a valid ai_level over the score band', () => {
      expect(resolveAiLevel({ ai_level: 2, ai_score: 95 })).toBe(2);
      expect(resolveAiLevel({ ai_level: '3', ai_score: null })).toBe(3);
      expect(resolveAiLevel({ ai_level: 7, ai_score: 65 })).toBe(3);
      expect(resolveAiLevel({ ai_level: null, ai_score: 'x' })).toBeNull();
    });

    it('reads the badge text of a listing page, not the JSON-LD', () => {
      expect(aiLevelFromPageHtml(readFixture('jobsbylevel-detail.html'))).toBe(1);
      expect(aiLevelFromPageHtml('<p>AI Level 3 of 4: Works with AI</p>')).toBe(3);
      expect(aiLevelFromPageHtml('<script>{"x":"AI Level 4 of 4"}</script><p>none</p>')).toBeNull();
      expect(aiLevelFromPageHtml('')).toBeNull();
    });
  });

  describe('country and location', () => {
    it.each([
      ['GB', 'GB'],
      ['gb', 'GB'],
      ['UK', 'GB'],
      ['us', 'US'],
      [' FR ', 'FR'],
      ['XK', 'XK'],
      ['ZZ', null],
      ['USA', null],
      ['', null],
      [null, null],
      [42, null],
    ])('normaliseCountryCode(%p) is %p', (raw, code) => {
      expect(normaliseCountryCode(raw)).toBe(code);
    });

    it.each([
      ['US-WA-Bellevue', 'Bellevue, WA, US'],
      ['San Francisco (United States)', 'San Francisco, United States'],
      ['India (remote)', 'India (remote)'],
      ['Remote (world)', 'Remote'],
      ['Hybrid Paris', 'Hybrid - Paris'],
      ['Hybrid - London', 'Hybrid - London'],
      ['Remote', 'Remote'],
      ['  Cambridge  ', 'Cambridge'],
    ])('normaliseLocationText(%p) is %p', (raw, text) => {
      expect(normaliseLocationText(raw)).toBe(text);
    });

    it.each([
      ['United Kingdom', 'GB', 'United Kingdom'],
      ['', 'GB', 'United Kingdom'],
      [null, 'GB', 'United Kingdom'],
      ['London', 'GB', 'London, United Kingdom'],
      ['UK - London', 'GB', 'UK - London'],
      ['US', 'US', 'US'],
      ['San Francisco, CA', 'US', 'San Francisco, CA, United States'],
      ['San Francisco / Tel Aviv / Zurich', 'US', 'San Francisco / Tel Aviv / Zurich'],
      ['Remote (world)', null, 'Remote'],
      [null, null, null],
    ])('buildLocationLabel(%p, %p) is %p', (raw, code, label) => {
      expect(buildLocationLabel(raw, code)).toBe(label);
    });

    it('a country query matches by ISO code and never sends a city', () => {
      const matcher = buildLocationMatcher('United Kingdom');
      expect(matcher?.country).toBe('United Kingdom');
      expect(matcher?.serverCity).toBeNull();
      expect(matcher?.matches('Remote - UK', 'GB')).toBe(true);
      expect(matcher?.matches('Paris, France', 'FR')).toBe(false);
    });

    it('a city query is a substring match and goes to the server as city', () => {
      const matcher = buildLocationMatcher('  London ');
      expect(matcher?.serverCity).toBe('London');
      expect(matcher?.matches('UK - London', 'GB')).toBe(true);
      expect(matcher?.matches('Londonderry', 'GB')).toBe(true);
      expect(matcher?.matches('Paris', 'FR')).toBe(false);
    });

    it('a short query matches whole words only', () => {
      const matcher = buildLocationMatcher('wa');
      expect(matcher?.matches('Bellevue, WA, US', 'US')).toBe(true);
      expect(matcher?.matches('Warsaw', 'PL')).toBe(false);
    });

    it('an empty query is no filter', () => {
      expect(buildLocationMatcher('   ')).toBeNull();
      expect(buildLocationMatcher(undefined)).toBeNull();
    });
  });

  describe('compensation', () => {
    it('a stated period wins', () => {
      expect(
        buildCompensation({ salary_min: 4000, salary_max: 5000, salary_currency: 'eur', salary_frequency: 'month' }),
      ).toMatchObject({ interval: CompensationInterval.MONTHLY, minAmount: 4000, maxAmount: 5000, currency: 'EUR' });
    });

    it('no period and amounts of 10 000 or more read as yearly', () => {
      expect(buildCompensation({ salary_min: 55620, salary_max: 61800, salary_currency: 'GBP' })).toMatchObject({
        interval: CompensationInterval.YEARLY,
      });
      expect(buildCompensation({ salary_min: null, salary_max: 10000, salary_currency: 'USD' })?.interval).toBe(
        CompensationInterval.YEARLY,
      );
    });

    it('no period and small amounts keep no interval (never guessed)', () => {
      const comp = buildCompensation({ salary_min: 25, salary_max: 40, salary_currency: 'USD' });
      expect(comp).not.toBeNull();
      expect(comp?.interval).toBeUndefined();
    });

    it('zero, negative or absent amounts give null', () => {
      expect(buildCompensation({ salary_min: 0, salary_max: 0 })).toBeNull();
      expect(buildCompensation({ salary_min: -5, salary_max: null })).toBeNull();
      expect(buildCompensation({})).toBeNull();
    });

    it('swaps inverted bounds and reads numeric strings', () => {
      expect(buildCompensation({ salary_min: '90000', salary_max: '70000', salary_currency: 'USD' })).toMatchObject({
        minAmount: 70000,
        maxAmount: 90000,
      });
    });
  });

  describe('labels, skills, flags', () => {
    it('humanises category slugs and drops placeholders', () => {
      expect(humaniseSlug('software-engineering')).toBe('Software Engineering');
      expect(humaniseSlug('data')).toBe('Data');
      expect(humaniseSlug('other')).toBeNull();
      expect(humaniseSlug('unknown')).toBeNull();
      expect(humaniseSlug(null)).toBeNull();
    });

    it('merges skills case-insensitively in first-seen order', () => {
      expect(mergeSkills(['SQL', 'Python', ''], ['python', 'dbt', 3], null)).toEqual(['SQL', 'Python', 'dbt']);
      expect(mergeSkills(undefined)).toEqual([]);
    });

    it.each([
      [true, true],
      [1, true],
      ['1', true],
      ['TRUE', true],
      ['yes', true],
      [false, false],
      [0, false],
      ['false', false],
      [null, false],
    ])('isTruthyFlag(%p) is %p', (value, flag) => {
      expect(isTruthyFlag(value)).toBe(flag);
    });

    it('maps descriptionDepth to a detail budget', () => {
      expect(detailBudgetFor('board')).toBe(0);
      expect(detailBudgetFor('detail-25')).toBe(5);
      expect(detailBudgetFor(undefined)).toBe(5);
      expect(detailBudgetFor('detail-all')).toBe(25);
      expect(detailBudgetFor('__proto__')).toBe(5);
    });
  });

  describe('URLs and the robots.txt guard', () => {
    it.each([
      'https://jobsbylevel.com/mcp',
      'https://jobsbylevel.com/feed.xml',
      'https://jobsbylevel.com/jobs/data-analyst-at-example-retail-0f9e8d',
    ])('allows %s', (url) => {
      expect(isAllowedJobsByLevelUrl(url)).toBe(true);
    });

    it.each([
      'https://jobsbylevel.com/api/v1/jobs',
      'https://jobsbylevel.com/api',
      'https://jobsbylevel.com/API/jobs',
      'https://jobsbylevel.com/feeds/jobs/recent.xml',
      'https://jobsbylevel.com/go/00000000-0000-4000-8000-00000000000a',
      'https://jobsbylevel.com/md/sitemap.xml',
      'https://jobsbylevel.com/jobs/edit/abc',
      'https://jobsbylevel.com/?q=engineer',
      'https://jobsbylevel.com/jobs/x?category=data',
      'http://jobsbylevel.com/mcp',
      'https://evil.example/mcp',
      'https://jobsbylevel.com:8443/mcp',
      'not a url',
    ])('refuses %s', (url) => {
      expect(isAllowedJobsByLevelUrl(url)).toBe(false);
    });

    it('reads a slug only from a Level listing URL', () => {
      expect(slugFromJobUrl('https://jobsbylevel.com/jobs/senior-x-at-y-80ffaa?utm_source=mcp')).toBe(
        'senior-x-at-y-80ffaa',
      );
      expect(slugFromJobUrl('https://www.jobsbylevel.com/jobs/abc-123/')).toBe('abc-123');
      expect(slugFromJobUrl('https://jobsbylevel.com/companies/coinbase')).toBeNull();
      expect(slugFromJobUrl('https://jobsbylevel.com/jobs/edit')).toBeNull();
      expect(slugFromJobUrl('https://jobsbylevel.com/jobs/a/b')).toBeNull();
      expect(slugFromJobUrl('http://jobsbylevel.com/jobs/abc')).toBeNull();
      expect(slugFromJobUrl('https://other.example/jobs/abc')).toBeNull();
      expect(slugFromJobUrl(null)).toBeNull();
    });
  });

  describe('MCP payloads', () => {
    const envelope = { total: 1, page: 1, per_page: 20, items: [{ slug: 'a' }] };
    const message = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] } };

    it('reads a parsed body, a JSON string and an SSE stream alike', () => {
      expect(parseMcpToolPayload(message)).toEqual(envelope);
      expect(parseMcpToolPayload(JSON.stringify(message))).toEqual(envelope);
      expect(parseMcpToolPayload(`event: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n`)).toEqual(envelope);
    });

    it('reads the captured wire response', () => {
      const payload = parseMcpToolPayload(JSON.parse(readFixture('jobsbylevel-mcp-search.rpc.json'))) as {
        items: unknown[];
        per_page: number;
      };
      expect(payload.items).toHaveLength(2);
      expect(payload.per_page).toBe(20);
    });

    it('prefers structuredContent when the server sends it', () => {
      expect(
        parseMcpToolPayload({ result: { structuredContent: envelope, content: [{ type: 'text', text: 'x' }] } }),
      ).toEqual(envelope);
    });

    it('an HTML body is blocked', () => {
      expect(diagnosticsOf(() => parseMcpToolPayload('  <html>Just a moment</html>')).reason).toBe('blocked');
    });

    it('a JSON-RPC error names its code; invalid params are bad_input', () => {
      expect(diagnosticsOf(() => parseMcpToolPayload({ error: { code: -32601, message: 'nope' } }))).toEqual({
        reason: 'unknown',
        detail: 'MCP error -32601: nope',
      });
      expect(diagnosticsOf(() => parseMcpToolPayload({ error: { code: -32602, message: 'bad' } })).reason).toBe(
        'bad_input',
      );
    });

    it('a tool error is unknown, or fetch_error when it is a rate limit', () => {
      const toolError = (text: string) => ({ result: { isError: true, content: [{ type: 'text', text }] } });
      expect(diagnosticsOf(() => parseMcpToolPayload(toolError('No such job'))).reason).toBe('unknown');
      expect(diagnosticsOf(() => parseMcpToolPayload(toolError('Too Many Requests'))).reason).toBe('fetch_error');
    });

    it('rejects shapes it cannot read', () => {
      expect(diagnosticsOf(() => parseMcpToolPayload(null)).reason).toBe('unknown');
      expect(diagnosticsOf(() => parseMcpToolPayload('garbage')).reason).toBe('unknown');
      expect(diagnosticsOf(() => parseMcpToolPayload({ result: { content: [] } })).detail).toContain('no text');
      expect(
        diagnosticsOf(() => parseMcpToolPayload({ result: { content: [{ type: 'text', text: 'not json' }] } })).detail,
      ).toContain('not JSON');
    });
  });

  describe('RSS feed', () => {
    it('parses the sample feed newest first', () => {
      const items = parseRssFeed(readFixture('jobsbylevel-feed.rss.xml'), 100);
      expect(items).toHaveLength(4);
      expect(items[0]).toEqual({
        slug: 'account-executive-enterprise-new-business-expansion-at-culture-amp-3aacff',
        url: 'https://jobsbylevel.com/jobs/account-executive-enterprise-new-business-expansion-at-culture-amp-3aacff',
        title: 'Account Executive, Enterprise (New Business & Expansion)',
        companyName: 'Culture Amp',
        postedAt: '2026-09-24T19:12:11.000Z',
        snippet: expect.stringContaining('big believers in the power of IRL'),
      });
      expect(items[2].snippet).toContain("This isn't a place for complacency");
    });

    it('honours the item cap', () => {
      expect(parseRssFeed(readFixture('jobsbylevel-feed.rss.xml'), 2)).toHaveLength(2);
    });

    it('reads CDATA, skips non-listing links and repeated slugs', () => {
      const xml = [
        '<rss><channel>',
        '<item><title><![CDATA[Head of Sales at Scale at Acme & Co]]></title>',
        '<link>https://jobsbylevel.com/jobs/head-of-sales-at-scale-at-acme-abc123</link>',
        '<pubDate>not a date</pubDate></item>',
        '<item><title>Elsewhere at Other</title><link>https://other.example/jobs/x</link></item>',
        '<item><title>Repeat at Acme</title><link>https://jobsbylevel.com/jobs/head-of-sales-at-scale-at-acme-abc123</link></item>',
        '</channel></rss>',
      ].join('\n');
      const items = parseRssFeed(xml, 100);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        title: 'Head of Sales at Scale',
        companyName: 'Acme & Co',
        postedAt: null,
        snippet: null,
      });
    });

    it('splits the company off at the last " at "', () => {
      expect(splitTitleCompany('Head of Sales at Scale at Acme')).toEqual({
        title: 'Head of Sales at Scale',
        companyName: 'Acme',
      });
      expect(splitTitleCompany('Staff Engineer')).toEqual({ title: 'Staff Engineer', companyName: null });
      expect(splitTitleCompany('at Acme')).toEqual({ title: 'at Acme', companyName: null });
    });
  });

  describe('listing page JSON-LD', () => {
    it('reads the description, salary, country, remote flag, ATS id and level', () => {
      const detail = parseDetailPage(readFixture('jobsbylevel-detail.html'));
      expect(detail).toMatchObject({
        descriptionIsHtml: true,
        countryCode: 'GB',
        remote: true,
        aiLevel: 1,
        atsId: '8224726',
        companyWebsite: null,
        employmentType: null,
      });
      expect(detail?.description).toContain('Own end-to-end investigations');
      expect(detail?.compensation).toMatchObject({
        interval: CompensationInterval.YEARLY,
        minAmount: 55620,
        maxAmount: 61800,
        currency: 'GBP',
      });
    });

    it('returns null for a page without a JobPosting', () => {
      expect(parseDetailPage('<html><body>Just a moment...</body></html>')).toBeNull();
    });
  });

  describe('state', () => {
    afterEach(() => resetJobsByLevelState());

    it('the TTL cache expires entries and evicts the oldest past its cap', () => {
      const cache = new JobsByLevelTtlCache<number>();
      cache.set('a', 1, 1000, 2, 0);
      cache.set('b', 2, 1000, 2, 10);
      expect(cache.get('a', 1000, 999)).toBe(1);
      expect(cache.get('a', 1000, 1000)).toBeUndefined();
      cache.set('c', 3, 1000, 2, 20);
      cache.set('d', 4, 1000, 2, 30);
      expect(cache.size).toBe(2);
      expect(cache.get('b', 1000, 40)).toBeUndefined();
      expect(cache.get('d', 1000, 40)).toBe(4);
      cache.set('e', 5, 0, 2, 50);
      expect(cache.get('e', 0, 50)).toBeUndefined();
    });

    it('reserves one slot per interval, even for simultaneous callers', () => {
      expect(reserveJobsByLevelSlot(1000, 1100)).toBe(0);
      expect(reserveJobsByLevelSlot(1000, 1100)).toBe(1100);
      expect(reserveJobsByLevelSlot(1000, 1100)).toBe(2200);
      expect(reserveJobsByLevelSlot(10_000, 1100)).toBe(0);
    });
  });
});
