import 'reflect-metadata';
import { AddressInfo } from 'net';
import { createServer, Server } from 'http';
import {
  HTTP_PIN_REDIRECTS_ENV,
  HttpClient,
  createHttpClient,
  redirectPinGuard,
} from '../src/http/http-client';

/**
 * Spec 1689 — `pinUrlToHosts` checks the first URL a plugin fetches; axios
 * then follows redirects anywhere. `allowedRedirectHosts` re-pins every hop.
 * Real loopback servers, real axios + follow-redirects: the SSRF shape is a
 * 302 from a fetched page to an internal address.
 */
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
  });

  afterAll(() => {
    delete process.env[HTTP_PIN_REDIRECTS_ENV];
  });

  it('control: without the option a redirect to an internal address is followed', async () => {
    const client = new HttpClient({ retries: 0 });
    const res = await client.get(redirectorUrl);
    expect(res.status).toBe(200);
    expect(res.data).toBe('internal-metadata');
    expect(internalHits).toBe(1);
  });

  it('refuses a hop off the allowed hosts, and never reaches it', async () => {
    const client = new HttpClient({ retries: 0, allowedRedirectHosts: ['acme.com'] });
    await expect(client.get(redirectorUrl)).rejects.toThrow(/Refused redirect to 127\.0\.0\.1:\d+/);
    expect(internalHits).toBe(0);
  });

  it('is carried through createHttpClient for a ScraperInputDto-shaped options object', async () => {
    const client = createHttpClient({
      proxies: undefined,
      requestTimeout: 10,
      retries: 0,
      allowedRedirectHosts: ['acme.com'],
    });
    await expect(client.get(redirectorUrl)).rejects.toThrow(/Refused redirect/);
    expect(internalHits).toBe(0);
  });

  it('EVER_JOBS_HTTP_PIN_REDIRECTS=false turns the pin off process-wide', async () => {
    process.env[HTTP_PIN_REDIRECTS_ENV] = 'false';
    const client = new HttpClient({ retries: 0, allowedRedirectHosts: ['acme.com'] });
    const res = await client.get(redirectorUrl);
    expect(res.data).toBe('internal-metadata');
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
