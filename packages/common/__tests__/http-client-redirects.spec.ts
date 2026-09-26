import 'reflect-metadata';
import { AddressInfo } from 'net';
import { createServer, Server } from 'http';
import { AxiosHeaders, InternalAxiosRequestConfig } from 'axios';
import {
  HTTP_PIN_REDIRECTS_ENV,
  HttpClient,
  createHttpClient,
  redirectPinGuard,
} from '../src/http/http-client';
import { CRAWL_ENV } from '../src/http/crawl/defaults';
import { EgressBlockedError } from '../src/http/crawl/errors';
import { resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import { resetHostLimiter } from '../src/http/crawl/host-limiter';
import { resetEffectiveCrawlPolicyCache } from '../src/http/crawl/scrape-context';

/**
 * Spec 1689 — `pinUrlToHosts` checks the first URL a plugin fetches; axios
 * then follows redirects anywhere. `allowedRedirectHosts` re-pins every hop.
 * Real loopback servers, real axios + follow-redirects: the SSRF shape is a
 * 302 from a fetched page to an internal address.
 *
 * The crawl policy's egress guard (Spec 1690 §4.8) refuses loopback on its own,
 * so these clients exempt the test servers through its documented escape hatch
 * `egressAllowHosts: ['127.0.0.1']` — the guard stays ON (the pin is what is
 * under test, and every hop still passes through the egress check).
 */
/** The loopback test servers, exempt from the crawl egress guard for a client. */
const LOOPBACK = ['127.0.0.1'];

function resetCrawlState(): void {
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
  resetHostLimiter();
}

describe('HttpClient redirect pinning (Spec 1689)', () => {
  let internal: Server;
  let internalHits = 0;
  let redirector: Server;
  let redirectorUrl = '';

  function listen(server: Server): Promise<number> {
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
  }

  beforeAll(async () => {
    internal = createServer((_req, res) => {
      internalHits++;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('internal-metadata');
    });
    const internalPort = await listen(internal);
    redirector = createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internalPort}/latest/meta-data/` });
      res.end();
    });
    redirectorUrl = `http://127.0.0.1:${await listen(redirector)}/careers`;
  });

  afterAll(async () => {
    await new Promise((resolve) => internal.close(resolve));
    await new Promise((resolve) => redirector.close(resolve));
  });

  beforeEach(() => {
    internalHits = 0;
    delete process.env[HTTP_PIN_REDIRECTS_ENV];
    delete process.env[CRAWL_ENV.BLOCK_PRIVATE_NETWORKS];
    resetCrawlState();
  });

  afterAll(() => {
    delete process.env[HTTP_PIN_REDIRECTS_ENV];
    delete process.env[CRAWL_ENV.BLOCK_PRIVATE_NETWORKS];
    resetCrawlState();
  });

  it('control: without the option a redirect to an internal address is followed', async () => {
    const client = new HttpClient({ retries: 0, egressAllowHosts: LOOPBACK });
    const res = await client.get(redirectorUrl);
    expect(res.status).toBe(200);
    expect(res.data).toBe('internal-metadata');
    expect(internalHits).toBe(1);
  });

  it('refuses a hop off the allowed hosts, and never reaches it', async () => {
    const client = new HttpClient({ retries: 0, allowedRedirectHosts: ['acme.com'], egressAllowHosts: LOOPBACK });
    await expect(client.get(redirectorUrl)).rejects.toThrow(/Refused redirect to 127\.0\.0\.1:\d+/);
    expect(internalHits).toBe(0);
  });

  it('is carried through createHttpClient for a ScraperInputDto-shaped options object', async () => {
    const client = createHttpClient({
      proxies: undefined,
      requestTimeout: 10,
      retries: 0,
      allowedRedirectHosts: ['acme.com'],
      egressAllowHosts: LOOPBACK,
    });
    await expect(client.get(redirectorUrl)).rejects.toThrow(/Refused redirect/);
    expect(internalHits).toBe(0);
  });

  it('EVER_JOBS_HTTP_PIN_REDIRECTS=false turns the pin off process-wide', async () => {
    process.env[HTTP_PIN_REDIRECTS_ENV] = 'false';
    const client = new HttpClient({ retries: 0, allowedRedirectHosts: ['acme.com'], egressAllowHosts: LOOPBACK });
    const res = await client.get(redirectorUrl);
    expect(res.data).toBe('internal-metadata');
  });

  it('pins every hop with the egress guard off as well (EVER_JOBS_CRAWL_BLOCK_PRIVATE_NETWORKS=false)', async () => {
    process.env[CRAWL_ENV.BLOCK_PRIVATE_NETWORKS] = 'false';
    resetCrawlState();
    const control = new HttpClient({ retries: 0 });
    expect((await control.get(redirectorUrl)).data).toBe('internal-metadata');
    expect(internalHits).toBe(1);

    const pinned = new HttpClient({ retries: 0, allowedRedirectHosts: ['acme.com'] });
    await expect(pinned.get(redirectorUrl)).rejects.toThrow(/Refused redirect to 127\.0\.0\.1:\d+/);
    expect(internalHits).toBe(1);
  });

  it('pins a call made straight through getAxiosInstance() too', async () => {
    const client = new HttpClient({ retries: 0, allowedRedirectHosts: ['acme.com'], egressAllowHosts: LOOPBACK });
    await expect(client.getAxiosInstance().get(redirectorUrl)).rejects.toThrow(/Refused redirect/);
    expect(internalHits).toBe(0);
  });

  it('pins a direct getAxiosInstance() call that brings its own beforeRedirect, egress guard off', async () => {
    process.env[CRAWL_ENV.BLOCK_PRIVATE_NETWORKS] = 'false';
    resetCrawlState();
    const own = jest.fn();
    const control = new HttpClient({ retries: 0 });
    expect((await control.getAxiosInstance().get(redirectorUrl, { beforeRedirect: own })).data).toBe('internal-metadata');
    expect(own).toHaveBeenCalledTimes(1);
    expect(internalHits).toBe(1);

    own.mockClear();
    const pinned = new HttpClient({ retries: 0, allowedRedirectHosts: ['acme.com'] });
    await expect(pinned.getAxiosInstance().get(redirectorUrl, { beforeRedirect: own })).rejects.toThrow(
      /Refused redirect to 127\.0\.0\.1:\d+/,
    );
    expect(own).not.toHaveBeenCalled();
    expect(internalHits).toBe(1);
  });

  describe('composed with the crawl egress guard (Spec 1690 §4.8)', () => {
    type BeforeRedirect = NonNullable<InternalAxiosRequestConfig['beforeRedirect']>;
    const response = { headers: {}, statusCode: 302 } as Parameters<BeforeRedirect>[1];
    const request = { url: 'https://acme.com/careers', method: 'GET', headers: {} } as unknown as Parameters<BeforeRedirect>[2];

    /** The `beforeRedirect` axios runs for `client.get(url, config)` — captured by a fake adapter, no network. */
    async function composedGuard(client: HttpClient, config: Record<string, unknown> = {}): Promise<BeforeRedirect> {
      let captured: InternalAxiosRequestConfig | undefined;
      client.getAxiosInstance().defaults.adapter = async (sent: InternalAxiosRequestConfig) => {
        captured = sent;
        return { data: '', status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: sent, request: {} };
      };
      await client.get('https://acme.com/careers', config);
      return captured!.beforeRedirect!;
    }

    it('runs the pin first, then the egress check, then the request’s own hook', async () => {
      const own = jest.fn();
      const guard = await composedGuard(new HttpClient({ allowedRedirectHosts: ['acme.com'] }), { beforeRedirect: own });

      expect(() => guard({ href: 'https://evil.example/' }, response, request)).toThrow(/Refused redirect to evil\.example/);
      expect(() => guard({ href: 'http://169.254.169.254/latest' }, response, request)).toThrow(/Refused redirect/);
      expect(own).not.toHaveBeenCalled();

      expect(() => guard({ href: 'https://jobs.acme.com/1', hostname: 'jobs.acme.com' }, response, request)).not.toThrow();
      expect(own).toHaveBeenCalledTimes(1);
    });

    it('keeps the egress check when the pin is switched off', async () => {
      process.env[HTTP_PIN_REDIRECTS_ENV] = 'false';
      const guard = await composedGuard(new HttpClient({ allowedRedirectHosts: ['acme.com'] }));

      expect(() => guard({ href: 'https://evil.example/', hostname: 'evil.example' }, response, request)).not.toThrow();
      expect(() => guard({ href: 'http://169.254.169.254/latest', hostname: '169.254.169.254' }, response, request)).toThrow(
        EgressBlockedError,
      );
    });

    it('lets no request-level beforeRedirect replace the pin', async () => {
      process.env[CRAWL_ENV.BLOCK_PRIVATE_NETWORKS] = 'false';
      resetCrawlState();
      const own = jest.fn();
      const guard = await composedGuard(new HttpClient({ allowedRedirectHosts: ['acme.com'] }), { beforeRedirect: own });

      expect(() => guard({ href: 'https://evil.example/' }, response, request)).toThrow(/Refused redirect/);
      expect(own).not.toHaveBeenCalled();
    });
  });

  describe('redirectPinGuard', () => {
    const guard = redirectPinGuard(['acme.com']);

    it.each([
      'https://acme.com/careers',
      'https://jobs.acme.com/careers?x=1',
    ])('lets %s through', (href) => {
      expect(() => guard({ href })).not.toThrow();
    });

    it.each([
      ['an https downgrade', 'http://acme.com/careers'],
      ['another host', 'https://evil.example/'],
      ['loopback', 'https://127.0.0.1/'],
      ['credentials', 'https://user:pw@acme.com/'],
      ['an explicit port', 'https://acme.com:8443/'],
      ['a missing href', undefined],
    ])('refuses %s', (_name, href) => {
      expect(() => guard({ href })).toThrow(/Refused redirect/);
    });

    it('never echoes a hop credential or query into the error', () => {
      expect(() => guard({ href: 'https://user:secret@evil.example/x?token=t0k' })).toThrow(
        /^Refused redirect to evil\.example: /,
      );
    });
  });
});
