import 'reflect-metadata';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { HttpClientOptions, createHttpClient } from '../src/http/http-client';
import { resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import { HostLimiter, resetHostLimiter } from '../src/http/crawl/host-limiter';
import { resetEffectiveCrawlPolicyCache, runWithScrapeContext } from '../src/http/crawl/scrape-context';
import {
  HTTP_MEMO_ENV,
  HTTP_MEMO_MAX_ENTRIES,
  httpMemoMethodsFromEnv,
  runWithHttpMemo,
} from '../src/http/http-memo';

/**
 * Spec 1700 (T13) — the scoped response memo in the shared HTTP client.
 * A real local server counts what actually reaches the network.
 *
 * The crawl policy's egress guard (Spec 1690 §4.8) refuses loopback on its own,
 * so every client here exempts the test server with `egressAllowHosts` — the
 * guard stays ON, as it is in production.
 */

/** The loopback test server, exempt from the crawl egress guard for a client. */
const LOOPBACK = ['127.0.0.1'];

interface Seen {
  method: string;
  url: string;
  body: string;
}

let server: Server;
let base: string;
const seen: Seen[] = [];
let respond: (req: IncomingMessage, res: ServerResponse, body: string) => void;

function defaultRespond(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ path: req.url, jobs: [{ id: 1, title: 'Engineer' }] }));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      respond(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
  respond = defaultRespond;
  // Spec 1690: fresh crawl-policy state, so pacing from one test never delays the next.
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
  resetHostLimiter();
});

function client(options: HttpClientOptions = {}) {
  return createHttpClient({ retries: 0, timeout: 5, egressAllowHosts: LOOPBACK, ...options });
}

describe('runWithHttpMemo — scoped response memo (Spec 1700)', () => {
  it('sends a repeated GET once inside a scope, and every time outside one', async () => {
    const { stats } = await runWithHttpMemo(async () => {
      for (let i = 0; i < 3; i++) await client().get(`${base}/board`);
    });
    expect(seen).toHaveLength(1);
    expect(stats).toEqual({ hits: 2, misses: 1 });

    seen.length = 0;
    for (let i = 0; i < 3; i++) await client().get(`${base}/board`);
    expect(seen).toHaveLength(3);
  });

  it('still sends one request per location when the location is in the request', async () => {
    await runWithHttpMemo(async () => {
      for (const city of ['NYC', 'Chicago', 'NYC']) {
        await client().get(`${base}/search`, { params: { l: city } });
      }
    });
    expect(seen.map((s) => s.url)).toEqual(['/search?l=NYC', '/search?l=Chicago']);
  });

  it('keys query params independent of their order', async () => {
    await runWithHttpMemo(async () => {
      await client().get(`${base}/search`, { params: { a: 1, b: 2 } });
      await client().get(`${base}/search`, { params: { b: 2, a: 1 } });
    });
    expect(seen).toHaveLength(1);
  });

  it('memoises an identical POST body, not a different one', async () => {
    await runWithHttpMemo(async () => {
      await client().post(`${base}/graphql`, { offset: 0, facets: {} });
      await client().post(`${base}/graphql`, { facets: {}, offset: 0 });
      await client().post(`${base}/graphql`, { offset: 20, facets: {} });
    });
    expect(seen.map((s) => s.body)).toEqual(['{"offset":0,"facets":{}}', '{"offset":20,"facets":{}}']);
  });

  it('GET only when asked', async () => {
    await runWithHttpMemo(
      async () => {
        await client().post(`${base}/graphql`, { q: 1 });
        await client().post(`${base}/graphql`, { q: 1 });
        await client().get(`${base}/board`);
        await client().get(`${base}/board`);
      },
      { methods: ['GET'] },
    );
    expect(seen.map((s) => s.method)).toEqual(['POST', 'POST', 'GET']);
  });

  it('is off with an empty method list', async () => {
    await runWithHttpMemo(
      async () => {
        await client().get(`${base}/board`);
        await client().get(`${base}/board`);
      },
      { methods: [] },
    );
    expect(seen).toHaveLength(2);
  });

  it('keys on headers, so a request with other headers is sent', async () => {
    await runWithHttpMemo(async () => {
      await client().get(`${base}/board`, { headers: { Accept: 'application/json' } });
      await client().get(`${base}/board`, { headers: { Accept: 'text/html' } });
      const c = client();
      c.setHeaders({ 'X-Tenant': 'a' });
      await c.get(`${base}/board`, { headers: { Accept: 'text/html' } });
    });
    expect(seen).toHaveLength(3);
  });

  it('gives every caller its own copy of the body', async () => {
    await runWithHttpMemo(async () => {
      const first = await client().get(`${base}/board`);
      first.data.jobs.length = 0;
      const second = await client().get(`${base}/board`);
      expect(second.data.jobs).toHaveLength(1);
      second.data.jobs.push({ id: 2 });
      const third = await client().get(`${base}/board`);
      expect(third.data.jobs).toHaveLength(1);
      expect(third.headers['content-type']).toContain('application/json');
      expect(third.status).toBe(200);
    });
    expect(seen).toHaveLength(1);
  });

  it('forgets a failed request, so the next caller sends it again', async () => {
    let calls = 0;
    respond = (req, res) => {
      calls++;
      if (calls === 1) {
        res.statusCode = 500;
        res.end('boom');
        return;
      }
      defaultRespond(req, res);
    };
    await runWithHttpMemo(async () => {
      await expect(client().get(`${base}/board`)).rejects.toThrow();
      await client().get(`${base}/board`);
      await client().get(`${base}/board`);
    });
    expect(seen).toHaveLength(2);
  });

  it('shares one in-flight request between concurrent identical callers', async () => {
    await runWithHttpMemo(async () => {
      await Promise.all([client().get(`${base}/board`), client().get(`${base}/board`)]);
    });
    expect(seen).toHaveLength(1);
  });

  it('never shares entries between two scopes', async () => {
    await Promise.all([
      runWithHttpMemo(async () => {
        await client().get(`${base}/board`);
      }),
      runWithHttpMemo(async () => {
        await client().get(`${base}/board`);
      }),
    ]);
    expect(seen).toHaveLength(2);
  });

  it('stops keeping responses at maxEntries', async () => {
    await runWithHttpMemo(
      async () => {
        await client().get(`${base}/a`);
        await client().get(`${base}/b`);
        await client().get(`${base}/b`);
        await client().get(`${base}/a`);
      },
      { maxEntries: 1 },
    );
    expect(seen.map((s) => s.url)).toEqual(['/a', '/b', '/b']);
    expect(HTTP_MEMO_MAX_ENTRIES).toBeGreaterThan(1);
  });

  it('replays Set-Cookie from a memo answer into the calling client’s jar', async () => {
    const cookies: Array<string | undefined> = [];
    respond = (req, res) => {
      cookies.push(req.headers.cookie);
      if (req.url === '/session') res.setHeader('set-cookie', 'sid=abc; Path=/');
      defaultRespond(req, res);
    };
    await runWithHttpMemo(async () => {
      const first = client({ cookies: true });
      await first.get(`${base}/session`);
      const second = client({ cookies: true });
      await second.get(`${base}/session`); // answered from the memo
      await second.get(`${base}/search`, { params: { l: 'x' } });
    });
    expect(seen.map((s) => s.url)).toEqual(['/session', '/search?l=x']);
    expect(cookies[1]).toBe('sid=abc');
  });

  it('does not memoise a body it cannot key', async () => {
    const buffer = Buffer.from('raw');
    await runWithHttpMemo(async () => {
      await client().post(`${base}/upload`, buffer);
      await client().post(`${base}/upload`, buffer);
    });
    expect(seen).toHaveLength(2);
  });
});

describe('runWithHttpMemo under the crawl policy (Spec 1690 × Spec 1700)', () => {
  it('a memo hit takes no rate-limit slot; every miss does', async () => {
    const limiter = new HostLimiter();
    const acquire = jest.spyOn(limiter, 'acquire');
    const { stats } = await runWithHttpMemo(async () => {
      for (let i = 0; i < 3; i++) await client({ hostLimiter: limiter }).get(`${base}/board`);
      await client({ hostLimiter: limiter }).get(`${base}/other`);
    });
    expect(seen.map((s) => s.url)).toEqual(['/board', '/other']);
    expect(stats).toEqual({ hits: 2, misses: 2 });
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('still refuses a private target before the memo is consulted (egress guard)', async () => {
    await runWithHttpMemo(async () => {
      await client().get(`${base}/board`);
      // Same URL, but a client without the loopback exemption: the literal
      // egress check runs before the memo, so the memo cannot launder it.
      await expect(createHttpClient({ retries: 0, timeout: 5 }).get(`${base}/board`)).rejects.toMatchObject({
        code: 'ERR_CRAWL_EGRESS_BLOCKED',
      });
    });
    expect(seen).toHaveLength(1);
  });

  it('never answers a redirect-pinned client with a response fetched without the pin', async () => {
    await runWithHttpMemo(async () => {
      await client().get(`${base}/board`);
      await client({ allowedRedirectHosts: ['acme.com'] }).get(`${base}/board`);
      await client({ allowedRedirectHosts: ['acme.com'] }).get(`${base}/board`);
    });
    expect(seen).toHaveLength(2);
  });

  it('keys on the per-request crawl override', async () => {
    await runWithHttpMemo(async () => {
      await client().request({ method: 'GET', url: `${base}/board` });
      await client().request({ method: 'GET', url: `${base}/board`, crawl: { robotsTxt: 'off', retries: 0 } } as never);
      await client().request({ method: 'GET', url: `${base}/board`, crawl: { retries: 0, robotsTxt: 'off' } } as never);
    });
    expect(seen).toHaveLength(2);
  });

  it('answers nothing, not even from the memo, once the scrape was aborted', async () => {
    const controller = new AbortController();
    await runWithHttpMemo(async () => {
      await runWithScrapeContext({ site: 'memo-test', signal: controller.signal }, async () => {
        await client().get(`${base}/board`);
        controller.abort(Object.assign(new Error('deadline'), { name: 'AbortError', code: 'ERR_TEST_ABORT' }));
        await expect(client().get(`${base}/board`)).rejects.toMatchObject({ code: 'ERR_TEST_ABORT' });
      });
    });
    expect(seen).toHaveLength(1);
  });

  it('a request parked on an identical in-flight one stops waiting when its own signal aborts', async () => {
    respond = (req, res) => {
      setTimeout(() => defaultRespond(req, res), 400);
    };
    const controller = new AbortController();
    const reason = Object.assign(new Error('caller gave up'), { name: 'AbortError', code: 'ERR_TEST_WAITER_ABORT' });
    const { stats } = await runWithHttpMemo(async () => {
      const first = client().get(`${base}/board`);
      const startedAt = Date.now();
      const parked = client().get(`${base}/board`, { signal: controller.signal });
      setTimeout(() => controller.abort(reason), 30);

      await expect(parked).rejects.toBe(reason);
      // Cancelled at the abort (~30 ms), not when the first request answered (~400 ms).
      expect(Date.now() - startedAt).toBeLessThan(300);
      // The first request still owns the entry and completes.
      await expect(first).resolves.toMatchObject({ status: 200 });
    });
    expect(seen).toHaveLength(1);
    expect(stats.hits).toBe(0);
  });

  it('a parked request whose signal never fires is still answered from the first one', async () => {
    respond = (req, res) => {
      setTimeout(() => defaultRespond(req, res), 50);
    };
    const controller = new AbortController();
    const { stats } = await runWithHttpMemo(async () => {
      const [a, b] = await Promise.all([
        client().get(`${base}/board`),
        client().get(`${base}/board`, { signal: controller.signal }),
      ]);
      expect(a.data).toEqual(b.data);
    });
    expect(seen).toHaveLength(1);
    expect(stats).toEqual({ hits: 1, misses: 1 });
  });

  it('does not memoise a request that brings its own transport', async () => {
    const agent = new (require('node:http').Agent)();
    await runWithHttpMemo(async () => {
      await client().get(`${base}/board`, { httpAgent: agent });
      await client().get(`${base}/board`, { httpAgent: agent });
    });
    agent.destroy();
    expect(seen).toHaveLength(2);
  });

  it('does not keep a throttled answer the caller accepted through validateStatus', async () => {
    let calls = 0;
    respond = (req, res) => {
      calls++;
      if (calls === 1) {
        res.statusCode = 429;
        res.end('slow down');
        return;
      }
      defaultRespond(req, res);
    };
    await runWithHttpMemo(async () => {
      const first = await client({ crawl: { throttleRetryDelayMs: 0, adaptiveThrottle: false } }).get(`${base}/board`, {
        validateStatus: () => true,
      });
      expect(first.status).toBe(429);
      resetHostLimiter();
      const second = await client({ crawl: { throttleRetryDelayMs: 0, adaptiveThrottle: false } }).get(`${base}/board`, {
        validateStatus: () => true,
      });
      expect(second.status).toBe(200);
    });
    expect(seen).toHaveLength(2);
  });
});

describe(`${HTTP_MEMO_ENV}`, () => {
  it.each([
    [undefined, ['GET', 'POST']],
    ['', ['GET', 'POST']],
    ['on', ['GET', 'POST']],
    [' GET ', ['GET']],
    ['off', []],
    ['false', []],
    ['0', []],
  ])('%p → %p', (value, expected) => {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { [HTTP_MEMO_ENV]: value };
    expect(httpMemoMethodsFromEnv(env)).toEqual(expected);
  });
});
