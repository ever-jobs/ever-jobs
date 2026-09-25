import 'reflect-metadata';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { createHttpClient } from '../src/http/http-client';
import {
  HTTP_MEMO_ENV,
  HTTP_MEMO_MAX_ENTRIES,
  httpMemoMethodsFromEnv,
  runWithHttpMemo,
} from '../src/http/http-memo';

/**
 * Spec 1700 (T13) — the scoped response memo in the shared HTTP client.
 * A real local server counts what actually reaches the network.
 */

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
});

function client() {
  return createHttpClient({ retries: 0, timeout: 5 });
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
      const first = createHttpClient({ retries: 0, timeout: 5, cookies: true });
      await first.get(`${base}/session`);
      const second = createHttpClient({ retries: 0, timeout: 5, cookies: true });
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
