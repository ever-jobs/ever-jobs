import 'reflect-metadata';
import { Agent, IncomingMessage, Server, createServer } from 'http';
import { AddressInfo, LookupFunction } from 'net';

import { HttpClient } from '../src/http/http-client';
import { CRAWL_ENV } from '../src/http/crawl/defaults';
import { CRAWL_EXTRA_ENV, resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import { RobotsDisallowedError } from '../src/http/crawl/errors';
import { HostLimiter, resetHostLimiter } from '../src/http/crawl/host-limiter';
import { resetRobotsTxtCache } from '../src/http/crawl/robots';
import { resetEffectiveCrawlPolicyCache, runWithScrapeContext } from '../src/http/crawl/scrape-context';

/**
 * Spec 1715 audit A0 — a redirect hop is paced by the HOP's policy
 * (`EVER_JOBS_CRAWL_PACE_REDIRECTS`, default on). Real axios + follow-redirects
 * against loopback servers; no network. The hosts are named (`*.softy.pro`,
 * `*.redirect.test`) through a client agent whose `lookup` sends every name to
 * 127.0.0.1 — so the builtin `*.softy.pro` host policy applies to the hop exactly
 * as it does in production (1 in flight per registrable domain, >= 1 s between
 * starts, >= 0.5 s idle after each answer).
 *
 * Timing is asserted on the limiter's own grant clock (the documented contract:
 * a `HostLimiter` spy records when each slot is granted), and, as lower bounds
 * only, on the server's arrival clock. Every pacing test has a red control:
 * `EVER_JOBS_CRAWL_PACE_REDIRECTS=false` (the pre-fix in-slot follow) makes the
 * same assertion fail, shown by the paired "control" test asserting the old timing.
 */

interface Hit {
  method: string;
  path: string;
  port: number;
  headers: IncomingMessage['headers'];
  body: string;
  arrivedAt: number;
}

type Route = (req: IncomingMessage, body: string) => { status: number; headers?: Record<string, string>; body?: string };

/** Every name resolves to the loopback interface (Node may ask for all addresses). */
const loopbackLookup = ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
  const cb = typeof options === 'function' ? (options as (...args: unknown[]) => void) : callback;
  const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
  if (all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
  else cb(null, '127.0.0.1', 4);
}) as unknown as LookupFunction;

const ENV_KEYS = [
  CRAWL_EXTRA_ENV.PACE_REDIRECTS,
  CRAWL_EXTRA_ENV.BUILTIN_HOSTS,
  CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE,
  CRAWL_ENV.PRESET,
  CRAWL_ENV.ROBOTS_TXT,
  CRAWL_ENV.POLICIES,
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
];

describe('HttpClient redirect pacing (Spec 1715 audit A0)', () => {
  const servers: Server[] = [];
  let hits: Hit[] = [];
  let agent: Agent;
  const saved: Record<string, string | undefined> = {};

  /** A loopback server answering by `route`; resolves to its port. */
  async function serve(route: Route): Promise<number> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const port = (server.address() as AddressInfo).port;
        hits.push({ method: req.method ?? '', path: req.url ?? '', port, headers: req.headers, body, arrivedAt: Date.now() });
        const answer = route(req, body);
        res.writeHead(answer.status, { 'Content-Type': 'text/plain', ...(answer.headers ?? {}) });
        res.end(answer.body ?? '');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return (server.address() as AddressInfo).port;
  }

  /**
   * A client with its own limiter whose grants are recorded: the bucket, the
   * limiter's OWN grant instant (the `now` its private `grant` receives — the clock
   * the pacing contract is stated in, Date.now) and the interval asked for. A
   * request reaches the server only after its grant, so for any request
   * `arrivedAt >= its grant >= the previous grant + interval` holds exactly; no
   * tolerance is needed (the wire gap between two ARRIVALS is not a valid bound:
   * the first request of a file pays a cold client path after its grant).
   */
  function pacedClient(): { client: HttpClient; grants: Array<{ bucket: string; at: number; minIntervalMs: number }> } {
    const limiter = new HostLimiter();
    const grants: Array<{ bucket: string; at: number; minIntervalMs: number }> = [];
    type Grant = (bucket: { key: string }, waiter: { limits: { minIntervalMs: number } }, now: number) => void;
    const internals = limiter as unknown as { grant: Grant };
    const grant = internals.grant.bind(limiter);
    jest.spyOn(internals, 'grant').mockImplementation((bucket, waiter, now) => {
      grants.push({ bucket: bucket.key, at: now, minIntervalMs: waiter.limits.minIntervalMs });
      grant(bucket, waiter, now);
    });
    return { client: new HttpClient({ retries: 0, hostLimiter: limiter }), grants };
  }

  const setEnv = (vars: Record<string, string | undefined>): void => {
    for (const [name, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
  };

  beforeAll(() => {
    for (const name of ENV_KEYS) saved[name] = process.env[name];
    agent = new Agent({ keepAlive: false, lookup: loopbackLookup } as ConstructorParameters<typeof Agent>[0]);
  });

  afterAll(async () => {
    for (const name of ENV_KEYS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    resetCrawlPolicyEnvCache();
    resetEffectiveCrawlPolicyCache();
    resetHostLimiter();
    resetRobotsTxtCache();
    agent.destroy();
    for (const server of servers) server.closeAllConnections?.();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  beforeEach(() => {
    hits = [];
    setEnv(Object.fromEntries(ENV_KEYS.map((name) => [name, undefined])));
    resetHostLimiter();
    resetRobotsTxtCache();
  });

  afterEach(() => jest.restoreAllMocks());

  const offers = (port: number) => hits.filter((h) => h.port === port && h.path.startsWith('/offers/'));

  describe('an aggregator redirect link into *.softy.pro (the A0 scenario)', () => {
    let softyPort = 0;
    let redirectPort = 0;

    beforeAll(async () => {
      softyPort = await serve(() => ({ status: 200, body: 'offer' }));
      redirectPort = await serve((req) => ({
        status: 302,
        headers: { Location: `http://acme.softy.pro:${softyPort}/offers/${(req.url ?? '').split('/').pop()}` },
      }));
    });

    async function probeTwo(client: HttpClient): Promise<void> {
      await runWithScrapeContext({ site: 'liveness-http' }, async () => {
        // A direct probe of the Softy offer, then (at once) an aggregator link that 302s to another offer.
        const direct = client.get(`http://acme.softy.pro:${softyPort}/offers/1`, { httpAgent: agent });
        const viaRedirect = client.get(`http://jobs.redirect.test:${redirectPort}/r/2`, { httpAgent: agent });
        const [a, b] = await Promise.all([direct, viaRedirect]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(b.data).toBe('offer');
      });
    }

    it('the hop waits for the Softy bucket: its own slot, >= 1 s after the direct probe', async () => {
      const { client, grants } = pacedClient();

      await probeTwo(client);

      const softyGrants = grants.filter((g) => g.bucket === 'domain:softy.pro');
      expect(softyGrants).toHaveLength(2); // the hop took a slot of its own
      expect(softyGrants[1].at - softyGrants[0].at).toBeGreaterThanOrEqual(1000);
      expect(softyGrants[1].minIntervalMs).toBe(1000); // under the builtin Softy policy
      const [first, second] = offers(softyPort);
      expect([first.path, second.path]).toEqual(['/offers/1', '/offers/2']);
      // On the wire: the hop reached the server >= 1 s after the direct probe was granted.
      expect(second.arrivedAt - softyGrants[0].at).toBeGreaterThanOrEqual(1000);
    });

    it('red control: EVER_JOBS_CRAWL_PACE_REDIRECTS=false follows the hop inside the aggregator slot, at once', async () => {
      setEnv({ [CRAWL_EXTRA_ENV.PACE_REDIRECTS]: 'false' });
      const { client, grants } = pacedClient();

      await probeTwo(client);

      const softyGrants = grants.filter((g) => g.bucket === 'domain:softy.pro');
      expect(softyGrants).toHaveLength(1);
      const hop = offers(softyPort).find((h) => h.path === '/offers/2');
      expect(hop!.arrivedAt - softyGrants[0].at).toBeLessThan(1000);
    });

    it('the legacy preset keeps the pre-fix in-slot follow (EVER_JOBS_CRAWL_PACE_REDIRECTS follows it)', async () => {
      setEnv({ [CRAWL_ENV.PRESET]: 'legacy', [CRAWL_EXTRA_ENV.BUILTIN_HOSTS]: 'true' });
      const { client, grants } = pacedClient();

      await probeTwo(client);

      expect(grants.filter((g) => g.bucket === 'domain:softy.pro')).toHaveLength(1);
    });

  });

  describe('the hop is checked against the target origin robots.txt (the pre-fix follow skipped it)', () => {
    // Two loopback origins (the ports make two host buckets and two robots.txt
    // origins), let through the egress guard by its documented per-client allow-list.
    let targetPort = 0;
    let redirectPort = 0;

    beforeAll(async () => {
      targetPort = await serve((req) =>
        req.url === '/robots.txt' ? { status: 200, body: 'User-agent: *\nDisallow: /offers/' } : { status: 200, body: 'offer' },
      );
      redirectPort = await serve((req) =>
        req.url === '/robots.txt'
          ? { status: 404 }
          : { status: 302, headers: { Location: `http://127.0.0.1:${targetPort}/offers/9` } },
      );
    });

    const fetchVia = async (): Promise<unknown> => {
      const limiter = new HostLimiter();
      const client = new HttpClient({ retries: 0, hostLimiter: limiter, egressAllowHosts: ['127.0.0.1'] });
      return client.get(`http://127.0.0.1:${redirectPort}/r/9`).catch((err: unknown) => err);
    };

    it('robots.txt respect: the disallowed hop is refused with RobotsDisallowedError', async () => {
      setEnv({ [CRAWL_ENV.ROBOTS_TXT]: 'respect' });

      const result = await fetchVia();

      expect(result).toBeInstanceOf(RobotsDisallowedError);
      expect(hits.filter((h) => h.port === targetPort).map((h) => h.path)).toEqual(['/robots.txt']);
    });

    it('red control: EVER_JOBS_CRAWL_PACE_REDIRECTS=false fetches the disallowed page through the redirect', async () => {
      setEnv({ [CRAWL_ENV.ROBOTS_TXT]: 'respect', [CRAWL_EXTRA_ENV.PACE_REDIRECTS]: 'false' });

      const result = (await fetchVia()) as { status?: number; data?: unknown };

      expect(result.status).toBe(200);
      expect(result.data).toBe('offer');
      expect(hits.filter((h) => h.port === targetPort).map((h) => h.path)).toEqual(['/offers/9']);
    });
  });

  describe('a same-host redirect on a host-owned policy (/offres -> /offers on a Softy tenant)', () => {
    let softyPort = 0;

    beforeAll(async () => {
      softyPort = await serve((req) =>
        (req.url ?? '').startsWith('/offres/')
          ? { status: 301, headers: { Location: (req.url ?? '').replace('/offres/', '/offers/') } }
          : { status: 200, body: 'offer' },
      );
    });

    it('the hop is re-issued in a new slot: 1 s after the redirect answer started', async () => {
      const { client, grants } = pacedClient();

      const response = await client.get(`http://acme.softy.pro:${softyPort}/offres/7`, { httpAgent: agent });

      expect(response.status).toBe(200);
      expect(grants.map((g) => g.bucket)).toEqual(['domain:softy.pro', 'domain:softy.pro']);
      expect(grants[1].at - grants[0].at).toBeGreaterThanOrEqual(1000);
      const paths = hits.filter((h) => h.port === softyPort);
      expect(paths.map((h) => h.path)).toEqual(['/offres/7', '/offers/7']);
      expect(paths[1].arrivedAt - grants[0].at).toBeGreaterThanOrEqual(1000);
    });

    it('red control: EVER_JOBS_CRAWL_PACE_REDIRECTS=false — both requests in one slot, back to back', async () => {
      setEnv({ [CRAWL_EXTRA_ENV.PACE_REDIRECTS]: 'false' });
      const { client, grants } = pacedClient();

      await client.get(`http://acme.softy.pro:${softyPort}/offres/8`, { httpAgent: agent });

      expect(grants).toHaveLength(1);
      const paths = hits.filter((h) => h.port === softyPort);
      expect(paths.map((h) => h.path)).toEqual(['/offres/8', '/offers/8']);
      expect(paths[1].arrivedAt - grants[0].at).toBeLessThan(1000);
    });

    it('EVER_JOBS_CRAWL_BUILTIN_HOSTS_DISABLE=*.softy.pro: not host-owned any more, the same-bucket hop follows in the slot', async () => {
      setEnv({ [CRAWL_EXTRA_ENV.BUILTIN_HOSTS_DISABLE]: '*.softy.pro' });
      const { client, grants } = pacedClient();

      await client.get(`http://acme.softy.pro:${softyPort}/offres/9`, { httpAgent: agent });

      expect(grants.map((g) => g.bucket)).toEqual([`host:acme.softy.pro:${softyPort}`]);
    });
  });

  describe('hops that stay in the bucket of an ordinary host keep the in-slot follow', () => {
    it('one slot, both paths answered', async () => {
      const port = await serve((req) =>
        req.url === '/a' ? { status: 302, headers: { Location: '/b' } } : { status: 200, body: 'b' },
      );
      const { client, grants } = pacedClient();

      const response = await client.get(`http://jobs.redirect.test:${port}/a`, { httpAgent: agent });

      expect(response.data).toBe('b');
      expect(grants.map((g) => g.bucket)).toEqual([`host:jobs.redirect.test:${port}`]);
      expect(hits.filter((h) => h.port === port).map((h) => h.path)).toEqual(['/a', '/b']);
    });
  });

  describe('what follow-redirects would change for a hop is kept (method, body, headers)', () => {
    let targetPort = 0;
    let redirectPort = 0;

    beforeAll(async () => {
      targetPort = await serve(() => ({ status: 200, body: 'landed' }));
      redirectPort = await serve((req) => {
        const code = Number((req.url ?? '').split('/')[2]);
        return { status: code, headers: { Location: `http://landing.other.test:${targetPort}/landing/${code}` } };
      });
    });

    /** The landing request as it reached the target, with pacing on and off. */
    async function landing(code: number, pace: boolean, config: Record<string, unknown>): Promise<Hit> {
      setEnv({ [CRAWL_EXTRA_ENV.PACE_REDIRECTS]: pace ? undefined : 'false' });
      hits = [];
      const { client, grants } = pacedClient();
      client.setHeaders({ Authorization: 'Bearer client-default', 'X-Client': 'kept' });
      await client.request({
        url: `http://form.redirect.test:${redirectPort}/r/${code}`,
        httpAgent: agent,
        ...config,
      });
      expect(grants.length).toBe(pace ? 2 : 1);
      const hit = hits.find((h) => h.port === targetPort);
      if (!hit) throw new Error('the hop never landed');
      return hit;
    }

    const POST = {
      method: 'post',
      data: { q: 'engineer' },
      headers: { Authorization: 'Bearer request', Cookie: 'sid=1', 'X-Request': 'kept' },
    };

    it.each([301, 302, 303])('POST + %d → GET without a body or Content-*, like the in-slot follow', async (code) => {
      const paced = await landing(code, true, POST);
      const control = await landing(code, false, POST);
      expect(paced.method).toBe('GET');
      expect(paced.body).toBe('');
      expect(paced.headers['content-type']).toBeUndefined();
      expect(paced.headers['content-length']).toBeUndefined();
      expect([control.method, control.body]).toEqual([paced.method, paced.body]);
    });

    it.each([307, 308])('POST + %d keeps the method and the body, like the in-slot follow', async (code) => {
      const paced = await landing(code, true, POST);
      const control = await landing(code, false, POST);
      expect(paced.method).toBe('POST');
      expect(JSON.parse(paced.body)).toEqual({ q: 'engineer' });
      expect(paced.headers['content-type']).toContain('application/json');
      expect([control.method, control.body]).toEqual([paced.method, paced.body]);
    });

    it('off-domain: Authorization and Cookie are dropped — a client default of that name is not merged back', async () => {
      const paced = await landing(302, true, { ...POST, method: 'get', data: undefined });
      const control = await landing(302, false, { ...POST, method: 'get', data: undefined });
      for (const hit of [paced, control]) {
        expect(hit.headers.authorization).toBeUndefined();
        expect(hit.headers.cookie).toBeUndefined();
        expect(hit.headers['x-request']).toBe('kept');
        expect(hit.headers['x-client']).toBe('kept');
      }
      expect(paced.headers['user-agent']).toBe(control.headers['user-agent']);
    });

    it('the per-request crawl override goes with the re-issued hop', async () => {
      setEnv({});
      const { client, grants } = pacedClient();
      const softy = await serve(() => ({ status: 200, body: 'offer' }));
      const redirector = await serve(() => ({ status: 302, headers: { Location: `http://acme.softy.pro:${softy}/offers/3` } }));

      await client.request({
        url: `http://jobs.redirect.test:${redirector}/r/3`,
        httpAgent: agent,
        crawl: { minIntervalMs: 2500 },
      } as Record<string, unknown>);

      expect(grants.map((g) => [g.bucket, g.minIntervalMs])).toEqual([
        [`host:jobs.redirect.test:${redirector}`, 2500],
        ['domain:softy.pro', 2500],
      ]);
    });
  });

  describe('the chain never exceeds maxRedirects (a hop counts wherever it is followed)', () => {
    it.each([true, false])('pace %s: maxRedirects 3 across two buckets → 4 requests, then ERR_FR_TOO_MANY_REDIRECTS', async (pace) => {
      setEnv({ [CRAWL_EXTRA_ENV.PACE_REDIRECTS]: pace ? undefined : 'false' });
      let portA = 0;
      let portB = 0;
      const bounce = (to: () => number) => (req: IncomingMessage) => {
        const n = Number((req.url ?? '').split('/').pop()) + 1;
        return { status: 302, headers: { Location: `http://hop.redirect.test:${to()}/hop/${n}` } };
      };
      portA = await serve(bounce(() => portB));
      portB = await serve(bounce(() => portA));
      const { client } = pacedClient();

      const error = await client
        .get(`http://hop.redirect.test:${portA}/hop/0`, { httpAgent: agent, maxRedirects: 3 })
        .catch((err: { code?: string; message?: string }) => err);

      expect(error).toMatchObject({ code: 'ERR_FR_TOO_MANY_REDIRECTS' });
      expect((error as { message: string }).message).toContain('Maximum number of redirects exceeded');
      expect(hits.filter((h) => h.port === portA || h.port === portB).map((h) => h.path)).toEqual([
        '/hop/0',
        '/hop/1',
        '/hop/2',
        '/hop/3',
      ]);
    });
  });

  describe('maxRedirects: 0 is untouched', () => {
    it('the 3xx comes back to the caller, nothing is re-issued', async () => {
      const target = await serve(() => ({ status: 200 }));
      const port = await serve(() => ({ status: 302, headers: { Location: `http://acme.softy.pro:${target}/offers/1` } }));
      const { client, grants } = pacedClient();

      const response = await client.get(`http://jobs.redirect.test:${port}/r/1`, {
        httpAgent: agent,
        maxRedirects: 0,
        validateStatus: () => true,
      });

      expect(response.status).toBe(302);
      expect(grants).toHaveLength(1);
      expect(hits.filter((h) => h.port === target)).toHaveLength(0);
    });
  });
});
