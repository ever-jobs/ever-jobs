import { Logger } from '@nestjs/common';

import { EVER_JOBS_DEFAULT_USER_AGENT, LEGACY_BROWSER_USER_AGENT } from '../src/http/crawl/defaults';
import { CrawlQueueTimeoutError, HostCoolingDownError } from '../src/http/crawl/errors';
import {
  ROBOTS_CACHE_ENV,
  RobotsFetcher,
  RobotsTxtCache,
  getRobotsTxtCache,
  resetRobotsTxtCache,
  robotsProductToken,
  robotsTxtCacheOptionsFromEnv,
  sanitizeRobotsTxt,
} from '../src/http/crawl/robots';

const ROBOTS = [
  '# comment',
  'User-agent: GPTBot',
  'Disallow: /',
  '',
  'User-agent: EverJobs',
  'Crawl-delay: 2.5',
  'Disallow: /private/',
  'Allow: /private/open',
  '',
  'User-agent: *',
  'Crawl-delay: 10',
  'Disallow: /admin',
  '',
  'Sitemap: https://acme.softy.pro/sitemap.xml',
  'Sitemap: https://acme.softy.pro/sitemap-offers.xml',
].join('\n');

function fetcherReturning(status: number | null, body = ''): jest.Mock<ReturnType<RobotsFetcher>, Parameters<RobotsFetcher>> {
  return jest.fn(async (_robotsUrl: string) => (status === null ? null : { status, body }));
}

describe('RobotsTxtCache — Spec 1690 §4.7', () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_700_000_000_000;
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetRobotsTxtCache();
  });

  it('mode off never fetches', async () => {
    const cache = new RobotsTxtCache({ now });
    const fetcher = fetcherReturning(200, 'User-agent: *\nDisallow: /');
    const decision = await cache.check('https://acme.softy.pro/offers', EVER_JOBS_DEFAULT_USER_AGENT, 'off', fetcher);
    expect(decision).toEqual({ allowed: true, sitemaps: [] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(cache.size).toBe(0);
  });

  it('fetches <origin>/robots.txt once per origin', async () => {
    const cache = new RobotsTxtCache({ now });
    const fetcher = fetcherReturning(200, ROBOTS);
    await cache.check('https://acme.softy.pro/offers/12?x=1', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
    await cache.check('https://acme.softy.pro/offers/13', EVER_JOBS_DEFAULT_USER_AGENT, 'crawl-delay', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://acme.softy.pro/robots.txt');

    await cache.check('http://acme.softy.pro/', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
    await cache.check('https://acme.softy.pro:8443/', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual([
      'https://acme.softy.pro/robots.txt',
      'http://acme.softy.pro/robots.txt',
      'https://acme.softy.pro:8443/robots.txt',
    ]);
  });

  describe('2xx: parsed', () => {
    it('respect: applies the EverJobs group for our UA (longest match, Allow wins ties)', async () => {
      const cache = new RobotsTxtCache({ now });
      const fetcher = fetcherReturning(200, ROBOTS);
      const check = (path: string) => cache.check(`https://acme.softy.pro${path}`, EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);

      expect((await check('/offers/1')).allowed).toBe(true);
      expect((await check('/private/cv')).allowed).toBe(false);
      expect((await check('/private/open/offer')).allowed).toBe(true);
      expect((await check('/admin')).allowed).toBe(true); // `*` rules do not apply when our group exists
    });

    it('reports Crawl-delay in ms for our token, and `*` for a foreign UA', async () => {
      const cache = new RobotsTxtCache({ now });
      const fetcher = fetcherReturning(200, ROBOTS);
      const ours = await cache.check('https://acme.softy.pro/', EVER_JOBS_DEFAULT_USER_AGENT, 'crawl-delay', fetcher);
      expect(ours.crawlDelayMs).toBe(2500);
      const browser = await cache.check('https://acme.softy.pro/admin', LEGACY_BROWSER_USER_AGENT, 'respect', fetcher);
      expect(browser.crawlDelayMs).toBe(10_000);
      expect(browser.allowed).toBe(false);
    });

    it('crawl-delay mode never refuses a URL', async () => {
      const cache = new RobotsTxtCache({ now });
      const fetcher = fetcherReturning(200, 'User-agent: *\nDisallow: /');
      const decision = await cache.check('https://x.example/anything', EVER_JOBS_DEFAULT_USER_AGENT, 'crawl-delay', fetcher);
      expect(decision.allowed).toBe(true);
    });

    it('returns Sitemap: lines', async () => {
      const cache = new RobotsTxtCache({ now });
      const decision = await cache.check('https://acme.softy.pro/', EVER_JOBS_DEFAULT_USER_AGENT, 'crawl-delay', fetcherReturning(200, ROBOTS));
      expect(decision.sitemaps).toEqual(['https://acme.softy.pro/sitemap.xml', 'https://acme.softy.pro/sitemap-offers.xml']);
    });

    it('omits crawlDelayMs when the matching group has none (no fallback to `*`)', async () => {
      const cache = new RobotsTxtCache({ now });
      const body = 'User-agent: EverJobs\nDisallow: /x\n\nUser-agent: *\nCrawl-delay: 5\n';
      const decision = await cache.check('https://x.example/', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcherReturning(200, body));
      expect(decision.crawlDelayMs).toBeUndefined();
    });

    it('matches a contact-extended default UA and a renamed operator UA', async () => {
      const cache = new RobotsTxtCache({ now });
      const body = 'User-agent: AcmeJobs\nDisallow: /\n\nUser-agent: EverJobs\nDisallow: /nope\n';
      const fetcher = fetcherReturning(200, body);
      const contact = 'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs; ops@acme.example)';
      expect((await cache.check('https://x.example/nope', contact, 'respect', fetcher)).allowed).toBe(false);
      expect((await cache.check('https://x.example/ok', contact, 'respect', fetcher)).allowed).toBe(true);
      expect((await cache.check('https://x.example/ok', 'AcmeJobs/2.0 (+ops@acme.example)', 'respect', fetcher)).allowed).toBe(false);
    });

    it('accepts a Buffer body', async () => {
      const cache = new RobotsTxtCache({ now });
      const fetcher = jest.fn(async () => ({ status: 200, body: Buffer.from('User-agent: *\nDisallow: /') as unknown as string }));
      expect((await cache.check('https://x.example/a', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher)).allowed).toBe(false);
    });

    it('parses only the first 512 KiB (a rule beyond the cap is ignored)', async () => {
      const cache = new RobotsTxtCache({ now });
      const padding = `# ${'x'.repeat(600 * 1024)}\n`;
      const body = `User-agent: *\nDisallow: /early\n${padding}Disallow: /late\n`;
      const fetcher = fetcherReturning(200, body);
      expect((await cache.check('https://x.example/early', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher)).allowed).toBe(false);
      expect((await cache.check('https://x.example/late', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher)).allowed).toBe(true);
    });

    it('drops a line cut in half by the size cap instead of reading a shorter rule', async () => {
      const cache = new RobotsTxtCache({ now, maxBytes: 40 });
      const body = 'User-agent: *\nDisallow: /a\nDisallow: /bbbbbbbbbbbbbbbbbbbb\n';
      // byte 40 falls inside the last line: "Disallow: /bbbb…" would otherwise become "Disallow: /b"
      const fetcher = fetcherReturning(200, body);
      expect((await cache.check('https://x.example/b', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher)).allowed).toBe(true);
      expect((await cache.check('https://x.example/a', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher)).allowed).toBe(false);
    });

    it('re-fetches after the 6 h TTL', async () => {
      const cache = new RobotsTxtCache({ now });
      const fetcher = fetcherReturning(200, ROBOTS);
      await cache.check('https://x.example/', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
      clock += 6 * 60 * 60 * 1000 - 1;
      await cache.check('https://x.example/', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
      clock += 1;
      await cache.check('https://x.example/', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  describe('4xx: missing → allow everything, cached', () => {
    it.each([401, 403, 404, 410])('%i allows all for the full TTL', async (status) => {
      const cache = new RobotsTxtCache({ now });
      const fetcher = fetcherReturning(status, 'User-agent: *\nDisallow: /');
      expect(await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher)).toEqual({ allowed: true, sitemaps: [] });
      clock += 60 * 60 * 1000;
      await cache.check('https://x.example/q', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(cache.peek('https://x.example')).toMatchObject({ outcome: 'missing', status });
    });

    it('an unfollowed 3xx is treated as missing', async () => {
      const cache = new RobotsTxtCache({ now });
      await cache.check('https://x.example/', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcherReturning(301));
      expect(cache.peek('https://x.example')).toMatchObject({ outcome: 'missing', status: 301 });
    });
  });

  describe('5xx / 429 / network: unreachable → allow, retried after 5 min', () => {
    const cases: Array<[string, () => RobotsFetcher]> = [
      ['500', () => fetcherReturning(500)],
      ['503', () => fetcherReturning(503)],
      ['429', () => fetcherReturning(429)],
      ['null (network error)', () => fetcherReturning(null)],
      [
        'a throwing fetcher',
        () =>
          jest.fn(async () => {
            throw new Error('ECONNRESET');
          }),
      ],
    ];

    it.each(cases)('%s', async (_label, make) => {
      const cache = new RobotsTxtCache({ now });
      const fetcher = jest.fn(make());
      const decision = await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
      expect(decision).toEqual({ allowed: true, sitemaps: [] });
      expect(cache.peek('https://x.example')?.outcome).toBe('unreachable');

      clock += 5 * 60 * 1000 - 1;
      await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
      expect(fetcher).toHaveBeenCalledTimes(1);
      clock += 1;
      await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('unreachable: disallow refuses in respect mode only (RFC 9309 reading)', async () => {
      const cache = new RobotsTxtCache({ now, unreachable: 'disallow' });
      const fetcher = fetcherReturning(503);
      expect((await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher)).allowed).toBe(false);
      expect((await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'crawl-delay', fetcher)).allowed).toBe(true);
      const missing = new RobotsTxtCache({ now, unreachable: 'disallow' });
      expect((await missing.check('https://y.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcherReturning(404))).allowed).toBe(true);
    });
  });

  it('concurrent checks for one origin share a single fetch', async () => {
    const cache = new RobotsTxtCache({ now });
    let resolveFetch!: (value: { status: number; body: string }) => void;
    const fetcher = jest.fn(
      () =>
        new Promise<{ status: number; body: string } | null>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const checks = Array.from({ length: 10 }, (_, i) =>
      cache.check(`https://x.example/p${i}`, EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveFetch({ status: 200, body: 'User-agent: *\nDisallow: /p3' });
    const decisions = await Promise.all(checks);
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false, true, true, true, true, true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  describe('a fetch that failed for a LOCAL reason is never cached for others', () => {
    const local: Array<[string, () => Error]> = [
      ['the initiator was cancelled (ERR_CANCELED)', () => Object.assign(new Error('canceled'), { code: 'ERR_CANCELED', name: 'CanceledError' })],
      ['the initiator aborted (AbortError)', () => Object.assign(new Error('aborted'), { name: 'AbortError' })],
      ['its limiter slot timed out', () => new CrawlQueueTimeoutError('host:x.example', 5000)],
      ['its bucket is cooling down', () => new HostCoolingDownError('host:x.example', 90_000)],
      ['wrapped by an HTTP library', () => Object.assign(new Error('wrapped'), { cause: new CrawlQueueTimeoutError('h', 1) })],
    ];

    it.each(local)('%s: rethrown to the initiator, not stored', async (_label, make) => {
      const cache = new RobotsTxtCache({ now });
      const fetcher = jest.fn(async () => {
        throw make();
      });

      await expect(cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher)).rejects.toBeDefined();
      expect(cache.peek('https://x.example')).toBeUndefined();

      const ok = fetcherReturning(200, 'User-agent: *\nDisallow: /p');
      const decision = await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', ok);
      expect(decision.allowed).toBe(false); // the site's rule applies on the next check, not a cached "allow"
      expect(ok).toHaveBeenCalledTimes(1);
    });

    it('callers that joined the failed fetch fetch again with their own fetcher', async () => {
      const cache = new RobotsTxtCache({ now });
      let failFirst!: (err: Error) => void;
      const initiator = jest.fn(
        () =>
          new Promise<{ status: number; body: string } | null>((_resolve, reject) => {
            failFirst = reject;
          }),
      );
      const joined = fetcherReturning(200, 'User-agent: *\nDisallow: /secret');

      const first = cache.check('https://x.example/a', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', initiator);
      const second = cache.check('https://x.example/secret', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', joined);
      failFirst(Object.assign(new Error('deadline'), { name: 'AbortError' }));

      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      expect((await second).allowed).toBe(false);
      expect(joined).toHaveBeenCalledTimes(1);
    });

    it('a site-side network failure is still cached as unreachable (not local)', async () => {
      const cache = new RobotsTxtCache({ now });
      const fetcher = jest.fn(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      });
      await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
      expect(cache.peek('https://x.example')?.outcome).toBe('unreachable');
    });
  });

  describe('hostile robots.txt is bounded (CPU)', () => {
    const hostile = (rules: number, pattern: string) =>
      ['User-agent: *', ...Array.from({ length: rules }, () => `Disallow: ${pattern}`)].join('\n');

    it('sanitizeRobotsTxt collapses * runs, cuts patterns, caps rules per group, and counts the cost', () => {
      const text = [
        'User-agent: *',
        'Disallow: /a***b',
        `Disallow: /${'x'.repeat(600)}`,
        'Disallow: /c',
        'Disallow: /d',
        '',
        'User-agent: EverJobs',
        'Disallow: /e*f',
      ].join('\n');
      const { text: out, costs } = sanitizeRobotsTxt(text, { maxRulesPerGroup: 3, maxPatternChars: 100 });
      const lines = out.split('\n');
      expect(lines[1]).toBe('Disallow: /a*b');
      expect(lines[2]).toBe(`Disallow: /${'x'.repeat(99)}`);
      expect(lines[4]).toBe(''); // 4th rule of the group dropped, line kept
      expect(lines[7]).toBe('Disallow: /e*f');
      expect(costs.get('*')).toEqual({ literalChars: 2 + 100 + 2, wildcardChars: 2 });
      expect(costs.get('everjobs')).toEqual({ literalChars: 2, wildcardChars: 2 });
    });

    it('a wildcard-heavy file within the budget is still evaluated exactly', async () => {
      const cache = new RobotsTxtCache({ now });
      const body = hostile(50, '/*a*a*a*b');
      const decision = await cache.check(`https://x.example/${'a'.repeat(40)}b`, EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcherReturning(200, body));
      expect(decision.allowed).toBe(false);
    });

    it('over maxMatchCost the URL is not evaluated (unreachable policy), fast, logged once per origin', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const cache = new RobotsTxtCache({ now });
      const body = hostile(11_000, `/*${'a*'.repeat(20)}b`);
      const fetcher = fetcherReturning(200, body);
      const longPath = `https://x.example/${'a'.repeat(2000)}`;

      const started = Date.now();
      const first = await cache.check(longPath, EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
      await cache.check(`${longPath}b`, EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
      const elapsed = Date.now() - started;

      expect(first.allowed).toBe(true); // unreachable = allow (default)
      expect(elapsed).toBeLessThan(2000);
      expect(warn).toHaveBeenCalledTimes(1);
      const strict = new RobotsTxtCache({ now, unreachable: 'disallow' });
      expect((await strict.check(longPath, EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcherReturning(200, body))).allowed).toBe(false);
    });

    it('memoises decisions per origin and path', async () => {
      const cache = new RobotsTxtCache({ now });
      await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcherReturning(200, 'User-agent: *\nDisallow: /p'));
      const robot = (cache as unknown as { entries: Map<string, { robot: { isAllowed: jest.Mock } }> }).entries.get('https://x.example')!.robot;
      const spy = jest.spyOn(robot, 'isAllowed');
      await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcherReturning(200, ''));
      await cache.check('https://x.example/p', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcherReturning(200, ''));
      expect(spy).not.toHaveBeenCalled();
    });

    it(`reads ${ROBOTS_CACHE_ENV.MAX_MATCH_COST}, ${ROBOTS_CACHE_ENV.MAX_RULES_PER_GROUP} and ${ROBOTS_CACHE_ENV.MAX_PATTERN_CHARS}`, () => {
      expect(
        robotsTxtCacheOptionsFromEnv({
          [ROBOTS_CACHE_ENV.MAX_MATCH_COST]: '1000',
          [ROBOTS_CACHE_ENV.MAX_RULES_PER_GROUP]: '10',
          [ROBOTS_CACHE_ENV.MAX_PATTERN_CHARS]: '64',
        }),
      ).toMatchObject({ maxMatchCost: 1000, maxRulesPerGroup: 10, maxPatternChars: 64 });
    });
  });

  it('is LRU-bounded by maxOrigins', async () => {
    const cache = new RobotsTxtCache({ now, maxOrigins: 2 });
    const fetcher = fetcherReturning(404);
    const check = (host: string) => cache.check(`https://${host}/`, EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
    await check('a.example');
    await check('b.example');
    await check('a.example'); // a is now the most recent
    await check('c.example'); // evicts b
    expect(cache.size).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await check('a.example');
    expect(fetcher).toHaveBeenCalledTimes(3);
    await check('b.example');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('allows non-HTTP and unparseable URLs without fetching', async () => {
    const cache = new RobotsTxtCache({ now });
    const fetcher = fetcherReturning(200, 'User-agent: *\nDisallow: /');
    expect((await cache.check('ftp://x.example/file', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher)).allowed).toBe(true);
    expect((await cache.check('not a url', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher)).allowed).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('invalidate() and clear() force a re-fetch', async () => {
    const cache = new RobotsTxtCache({ now });
    const fetcher = fetcherReturning(404);
    await cache.check('https://x.example/', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
    expect(cache.invalidate('https://x.example')).toBe(true);
    await cache.check('https://x.example/', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
    cache.clear();
    await cache.check('https://x.example/', EVER_JOBS_DEFAULT_USER_AGENT, 'respect', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  describe('singleton and env', () => {
    it('getRobotsTxtCache returns one shared instance; resetRobotsTxtCache replaces or drops it', () => {
      const first = getRobotsTxtCache();
      expect(getRobotsTxtCache()).toBe(first);
      const custom = new RobotsTxtCache({ maxOrigins: 1 });
      resetRobotsTxtCache(custom);
      expect(getRobotsTxtCache()).toBe(custom);
      resetRobotsTxtCache();
      expect(getRobotsTxtCache()).not.toBe(custom);
    });

    it('reads its tunables from the environment, ignoring invalid values with a warning', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      expect(
        robotsTxtCacheOptionsFromEnv({
          [ROBOTS_CACHE_ENV.MAX_ORIGINS]: '100',
          [ROBOTS_CACHE_ENV.TTL_MS]: '60000',
          [ROBOTS_CACHE_ENV.ERROR_TTL_MS]: '1000',
          [ROBOTS_CACHE_ENV.MAX_BYTES]: '2048',
          [ROBOTS_CACHE_ENV.UNREACHABLE]: 'Disallow',
        }),
      ).toEqual({ maxOrigins: 100, ttlMs: 60000, errorTtlMs: 1000, maxBytes: 2048, unreachable: 'disallow' });
      expect(
        robotsTxtCacheOptionsFromEnv({ [ROBOTS_CACHE_ENV.MAX_ORIGINS]: 'many', [ROBOTS_CACHE_ENV.UNREACHABLE]: 'maybe' }),
      ).toEqual({ maxOrigins: undefined, ttlMs: undefined, errorTtlMs: undefined, maxBytes: undefined });
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('robotsProductToken', () => {
  it('is EverJobs for our UA in every configured form', () => {
    expect(robotsProductToken(EVER_JOBS_DEFAULT_USER_AGENT)).toBe('EverJobs');
    expect(robotsProductToken('EverJobs/2.0')).toBe('EverJobs');
    expect(robotsProductToken('Mozilla/5.0 (compatible; everjobs; +mailto:ops@acme.example)')).toBe('EverJobs');
    expect(robotsProductToken(undefined)).toBe('EverJobs');
    expect(robotsProductToken('')).toBe('EverJobs');
  });

  it('is the first product token of any other UA', () => {
    expect(robotsProductToken(LEGACY_BROWSER_USER_AGENT)).toBe('Mozilla');
    expect(robotsProductToken('AcmeJobs/2.0 (+https://github.com/ever-jobs/ever-jobs)')).toBe('AcmeJobs');
    expect(robotsProductToken('someone@agency.gov')).toBe('someone@agency.gov');
    expect(robotsProductToken('(weird)')).toBe('*');
  });

  it('does not mistake a URL or a longer word for our token', () => {
    expect(robotsProductToken('Bot/1.0 (+https://everjobs.example)')).toBe('Bot');
    expect(robotsProductToken('NotEverJobs/1.0')).toBe('NotEverJobs');
  });
});
