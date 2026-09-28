import 'reflect-metadata';
import { Agent, IncomingMessage, Server, createServer } from 'http';
import { AddressInfo, LookupFunction, Socket, connect as netConnect } from 'net';

import { HttpClient } from '../src/http/http-client';
import { CRAWL_ENV } from '../src/http/crawl/defaults';
import { CRAWL_EXTRA_ENV, resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import { RobotsDisallowedError } from '../src/http/crawl/errors';
import { HostLimiter, resetHostLimiter } from '../src/http/crawl/host-limiter';
import { resetRobotsTxtCache } from '../src/http/crawl/robots';
import { resetEffectiveCrawlPolicyCache, runWithScrapeContext } from '../src/http/crawl/scrape-context';
import { runWithHttpMemo } from '../src/http/http-memo';

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
 *
 * Review round 2: a hop is re-issued only when a lock or a host policy applies — the
 * hop host is host-owned (`*.softy.pro`), or the request or the hop is under a
 * caller lock (here: `EVER_JOBS_CRAWL_CALLER_OVERRIDES=stricter`) and the hop
 * leaves the bucket. A source WITHOUT a lock follows every other hop in its slot,
 * with its proxy, as before Spec 1714 (rule 3). A re-issued hop never consults the
 * multi-location memo, so a redirect loop fails instead of waiting on itself.
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
  CRAWL_ENV.CALLER_OVERRIDES,
  CRAWL_ENV.PROXIES,
  'DEFAULT_PROXIES',
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
  const tunnels: Socket[] = [];
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
  function pacedClient(
    options: { egressAllowHosts?: string[] } = {},
  ): { client: HttpClient; grants: Array<{ bucket: string; at: number; minIntervalMs: number }> } {
    const limiter = new HostLimiter();
    const grants: Array<{ bucket: string; at: number; minIntervalMs: number }> = [];
    type Grant = (bucket: { key: string }, waiter: { limits: { minIntervalMs: number } }, now: number) => void;
    const internals = limiter as unknown as { grant: Grant };
    const grant = internals.grant.bind(limiter);
    jest.spyOn(internals, 'grant').mockImplementation((bucket, waiter, now) => {
      grants.push({ bucket: bucket.key, at: now, minIntervalMs: waiter.limits.minIntervalMs });
      grant(bucket, waiter, now);
    });
    return { client: new HttpClient({ retries: 0, hostLimiter: limiter, ...options }), grants };
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
    for (const socket of tunnels) socket.destroy();
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

  /**
   * A loopback CONNECT proxy (what an operator's EVER_JOBS_CRAWL_PROXIES entry is):
   * it tunnels every CONNECT to 127.0.0.1 on the requested port and records the
   * `host:port` each tunnel was opened for, so a test sees which proxy carried
   * which request.
   */
  async function connectProxy(seen: string[]): Promise<number> {
    const proxy = createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    proxy.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
      seen.push(req.url ?? '');
      tunnels.push(client);
      const port = Number((req.url ?? '').split(':').pop());
      const upstream = netConnect(port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      tunnels.push(upstream);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    servers.push(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
    return (proxy.address() as AddressInfo).port;
  }

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

  describe('under a caller lock the hop is checked against the target origin robots.txt (the pre-fix follow skipped it)', () => {
    // Two loopback origins (the ports make two host buckets and two robots.txt
    // origins), let through the egress guard by its documented per-client allow-list.
    // EVER_JOBS_CRAWL_CALLER_OVERRIDES=stricter puts every request under a caller lock.
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
      setEnv({ [CRAWL_ENV.ROBOTS_TXT]: 'respect', [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });

      const result = await fetchVia();

      expect(result).toBeInstanceOf(RobotsDisallowedError);
      expect(hits.filter((h) => h.port === targetPort).map((h) => h.path)).toEqual(['/robots.txt']);
    });

    it('red control: EVER_JOBS_CRAWL_PACE_REDIRECTS=false fetches the disallowed page through the redirect', async () => {
      setEnv({
        [CRAWL_ENV.ROBOTS_TXT]: 'respect',
        [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter',
        [CRAWL_EXTRA_ENV.PACE_REDIRECTS]: 'false',
      });

      const result = (await fetchVia()) as { status?: number; data?: unknown };

      expect(result.status).toBe(200);
      expect(result.data).toBe('offer');
      expect(hits.filter((h) => h.port === targetPort).map((h) => h.path)).toEqual(['/offers/9']);
    });

    it('without a lock (the default any) the hop follows in the slot as before Spec 1714 — byte-identical (rule 3)', async () => {
      setEnv({ [CRAWL_ENV.ROBOTS_TXT]: 'respect' });

      const result = (await fetchVia()) as { status?: number; data?: unknown };

      expect(result.status).toBe(200);
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

    /**
     * The landing request as it reached the target, with pacing on (under a caller
     * lock, so the cross-host hop is re-issued) and off.
     */
    async function landing(code: number, pace: boolean, config: Record<string, unknown>): Promise<Hit> {
      setEnv({ [CRAWL_EXTRA_ENV.PACE_REDIRECTS]: pace ? undefined : 'false', [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });
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
    it.each([
      [true, 'stricter'],
      [true, undefined],
      [false, 'stricter'],
      [false, undefined],
    ])('pace %s, caller overrides %s: maxRedirects 3 across two buckets → 4 requests, then ERR_FR_TOO_MANY_REDIRECTS', async (pace, lock) => {
      setEnv({ [CRAWL_EXTRA_ENV.PACE_REDIRECTS]: pace ? undefined : 'false', [CRAWL_ENV.CALLER_OVERRIDES]: lock });
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

  describe('an unlocked source keeps its slot and its proxy on a cross-host redirect (review round 2, rule 3)', () => {
    /**
     * Golden: 4 loopback CONNECT proxies as the operator's EVER_JOBS_CRAWL_PROXIES,
     * the default polite preset (per-host rotation), no scrape context, an A -> B 302
     * across hosts. Develop (and EVER_JOBS_CRAWL_PACE_REDIRECTS=false) follows the hop
     * inside A's slot, through A's proxy: one grant, both tunnels on one proxy.
     * Red control: the round-1 code re-issued the hop (a second grant and a second
     * pick keyed on B's bucket — another egress IP mid-chain); the locked twin below
     * shows that path, which a caller lock still takes.
     */
    let targetPort = 0;
    let redirectPort = 0;
    const seen: string[][] = [[], [], [], []];
    const proxyUrls: string[] = [];

    beforeAll(async () => {
      targetPort = await serve(() => ({ status: 200, body: 'landed' }));
      redirectPort = await serve(() => ({ status: 302, headers: { Location: `http://b.redirect.test:${targetPort}/landing` } }));
      for (const list of seen) proxyUrls.push(`http://127.0.0.1:${await connectProxy(list)}`);
    });

    /** The buckets granted, and per proxy (index into EVER_JOBS_CRAWL_PROXIES) the tunnels opened through it. */
    async function chain(vars: Record<string, string | undefined>): Promise<{ grants: string[]; tunnels: string[][] }> {
      for (const list of seen) list.length = 0;
      setEnv({ [CRAWL_ENV.PROXIES]: proxyUrls.join(','), ...vars });
      const { client, grants } = pacedClient();
      const response = await client.get(`http://a.redirect.test:${redirectPort}/r`);
      expect(response.data).toBe('landed');
      return { grants: grants.map((g) => g.bucket), tunnels: seen.map((list) => [...list]) };
    }

    const expectOneProxy = (tunnels: string[][]): void => {
      const used = tunnels.filter((list) => list.length > 0);
      expect(used).toEqual([[`a.redirect.test:${redirectPort}`, `b.redirect.test:${targetPort}`]]);
    };

    it('default env: one slot, and the hop leaves through the same proxy as the first request', async () => {
      const { grants, tunnels } = await chain({});

      expect(grants).toEqual([`host:a.redirect.test:${redirectPort}`]);
      expectOneProxy(tunnels);
    });

    it('EVER_JOBS_CRAWL_PACE_REDIRECTS=false (the develop behaviour) is the same', async () => {
      const { grants, tunnels } = await chain({ [CRAWL_EXTRA_ENV.PACE_REDIRECTS]: 'false' });

      expect(grants).toEqual([`host:a.redirect.test:${redirectPort}`]);
      expectOneProxy(tunnels);
    });

    it('under a caller lock the hop is re-issued: its own slot, its own pick', async () => {
      const { grants, tunnels } = await chain({ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });

      expect(grants).toEqual([`host:a.redirect.test:${redirectPort}`, `host:b.redirect.test:${targetPort}`]);
      expect(tunnels.flat().sort()).toEqual([`a.redirect.test:${redirectPort}`, `b.redirect.test:${targetPort}`].sort());
    });
  });

  describe('a redirect loop inside a multi-location memo scope fails instead of hanging (review round 2)', () => {
    /**
     * A re-issued hop used to consult the memo: a chain coming back to a URL it had
     * visited found its own ancestor's entry still pending and waited on itself —
     * two requests, then no answer (the search deadline was the only way out).
     * Red control: the round-1 `send()` (memo lookup for re-issued hops) settles as
     * 'hung' here. The requests bring no agent of their own (one would make them
     * unmemoisable): two loopback ORIGINS (two ports = two host buckets), let through
     * the egress guard by the client's documented allow-list.
     */
    const LOOP_DEADLINE_MS = 8000;
    const settleWithin = <T>(promise: Promise<T>): Promise<T | 'hung'> =>
      Promise.race([
        promise,
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), LOOP_DEADLINE_MS).unref()),
      ]);

    it('two origins bouncing (A -> B -> A) under a caller lock: ERR_FR_TOO_MANY_REDIRECTS after maxRedirects', async () => {
      setEnv({ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });
      let portA = 0;
      let portB = 0;
      portA = await serve(() => ({ status: 302, headers: { Location: `http://127.0.0.1:${portB}/x` } }));
      portB = await serve(() => ({ status: 302, headers: { Location: `http://127.0.0.1:${portA}/x` } }));
      const { client, grants } = pacedClient({ egressAllowHosts: ['127.0.0.1'] });

      const { result, stats } = await runWithHttpMemo(() =>
        settleWithin(client.get(`http://127.0.0.1:${portA}/x`, { maxRedirects: 5 }).catch((err: { code?: string }) => err)),
      );

      expect(result).not.toBe('hung');
      expect(result).toMatchObject({ code: 'ERR_FR_TOO_MANY_REDIRECTS' });
      expect(hits.filter((h) => h.port === portA || h.port === portB)).toHaveLength(6);
      expect(grants).toHaveLength(6); // every hop re-issued in a slot of its own
      expect(stats.hits).toBe(0);
    }, 20000);

    it('a same-URL bounce on a host-owned policy (an operator hosts entry with a lock): the same error', async () => {
      setEnv({
        [CRAWL_ENV.POLICIES]: JSON.stringify({ hosts: { '127.0.0.1': { callerOverrides: 'stricter', minIntervalMs: 50 } } }),
      });
      const port = await serve((req) => ({ status: 301, headers: { Location: req.url ?? '/' } }));
      const { client, grants } = pacedClient({ egressAllowHosts: ['127.0.0.1'] });

      const { result } = await runWithHttpMemo(() =>
        settleWithin(client.get(`http://127.0.0.1:${port}/offers/1`, { maxRedirects: 2 }).catch((err: { code?: string }) => err)),
      );

      expect(result).not.toBe('hung');
      expect(result).toMatchObject({ code: 'ERR_FR_TOO_MANY_REDIRECTS' });
      expect(hits.filter((h) => h.port === port).map((h) => h.path)).toEqual(['/offers/1', '/offers/1', '/offers/1']);
      expect(grants).toHaveLength(3);
    }, 20000);

    it('outside a memo scope the same loop fails the same way (the memo is the only difference)', async () => {
      setEnv({ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' });
      let portA = 0;
      let portB = 0;
      portA = await serve(() => ({ status: 302, headers: { Location: `http://127.0.0.1:${portB}/y` } }));
      portB = await serve(() => ({ status: 302, headers: { Location: `http://127.0.0.1:${portA}/y` } }));
      const { client } = pacedClient({ egressAllowHosts: ['127.0.0.1'] });

      const result = await settleWithin(
        client.get(`http://127.0.0.1:${portA}/y`, { maxRedirects: 5 }).catch((err: { code?: string }) => err),
      );

      expect(result).toMatchObject({ code: 'ERR_FR_TOO_MANY_REDIRECTS' });
    }, 20000);
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
