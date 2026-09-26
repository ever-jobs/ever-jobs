import 'reflect-metadata';

const mockAxiosRequest = jest.fn();
/**
 * A minimal axios instance: `request` runs the registered request interceptors
 * (the crawl-policy identity interceptor since Spec 1690) over the config, then
 * hands it to `mockAxiosRequest`.
 */
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => {
      const requestHandlers: Array<(config: any) => any> = [];
      return {
        request: jest.fn(async (config: any) => {
          let cfg = config;
          for (const handler of requestHandlers) {
            cfg = await handler(cfg);
          }
          return mockAxiosRequest(cfg);
        }),
        defaults: { headers: { common: {} } },
        interceptors: {
          request: { use: jest.fn((handler: any) => requestHandlers.push(handler)) },
          response: { use: jest.fn() },
        },
      };
    }),
  },
}));

import axios from 'axios';
import { HttpClient } from '../src/http/http-client';
import { runWithRequestId } from '../src/context';
import { CRAWL_ENV, EVER_JOBS_DEFAULT_USER_AGENT, LEGACY_BROWSER_USER_AGENT } from '../src/http/crawl/defaults';
import { resetCrawlPolicyEnvCache } from '../src/http/crawl/env';
import { resetHostLimiter } from '../src/http/crawl/host-limiter';
import { resetEffectiveCrawlPolicyCache } from '../src/http/crawl/scrape-context';

function httpError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, headers },
  });
}

/** Fresh crawl-policy state per test: env parse, memo, and the process-wide limiter. */
function resetCrawlState(): void {
  resetCrawlPolicyEnvCache();
  resetEffectiveCrawlPolicyCache();
  resetHostLimiter();
}

const savedPreset = process.env[CRAWL_ENV.PRESET];

function restorePreset(): void {
  if (savedPreset === undefined) delete process.env[CRAWL_ENV.PRESET];
  else process.env[CRAWL_ENV.PRESET] = savedPreset;
  resetCrawlState();
}

/**
 * Spec 5085 — a retry log line that does not name its own request cannot be
 * attributed to anything, and a 429 must honor the pause the server asked for.
 *
 * These pin the pre-1690 retry arithmetic (3 linear retries on 429/5xx, no
 * jitter, Retry-After capped by `retryMaxDelay`), which Spec 1690 keeps
 * byte-for-byte under `EVER_JOBS_CRAWL_PRESET=legacy`. The polite default's
 * arithmetic is covered in `http-client-crawl-policy.spec.ts`.
 */
describe('HttpClient retry attribution and Retry-After — Spec 5085 (legacy preset)', () => {
  beforeEach(() => {
    mockAxiosRequest.mockReset();
    process.env[CRAWL_ENV.PRESET] = 'legacy';
    resetCrawlState();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restorePreset();
  });

  /** Drive a request to completion without waiting out the retry sleep. */
  async function run<T>(promise: Promise<T>): Promise<T | Error> {
    const settled = promise.catch((err: Error) => err);
    await jest.advanceTimersByTimeAsync(60_000);
    return settled;
  }

  it('names the method and URL of the request that failed', async () => {
    const client = new HttpClient({ retries: 1 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce({ data: 'ok' });

    await run(client.get('https://acme.example.com/wday/cxs/acme/Careers/job/R-1'));

    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger.mock.calls[0][0]).toContain(
      'GET https://acme.example.com/wday/cxs/acme/Careers/job/R-1 failed 429, retry 1/1',
    );
  });

  it('carries the request-context correlation id when one is in scope', async () => {
    const client = new HttpClient({ retries: 1 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({ data: 'ok' });

    await runWithRequestId('req-abc', () =>
      run(client.post('https://acme.example.com/api', {})),
    );

    expect(logger.mock.calls[0][0]).toContain('[req-abc] POST https://acme.example.com/api');
  });

  it('waits the Retry-After delta instead of the computed backoff', async () => {
    const client = new HttpClient({ retries: 1, retryDelay: 1000 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest
      .mockRejectedValueOnce(httpError(429, { 'retry-after': '5' }))
      .mockResolvedValueOnce({ data: 'ok' });

    await run(client.get('https://acme.example.com/api'));

    expect(logger.mock.calls[0][0]).toContain('in 5000ms');
  });

  it('clamps an over-large Retry-After to retryMaxDelay', async () => {
    const client = new HttpClient({ retries: 1, retryMaxDelay: 3000 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest
      .mockRejectedValueOnce(httpError(429, { 'retry-after': '600' }))
      .mockResolvedValueOnce({ data: 'ok' });

    await run(client.get('https://acme.example.com/api'));

    expect(logger.mock.calls[0][0]).toContain('in 3000ms');
  });

  it('falls back to the computed backoff when Retry-After is absent', async () => {
    const client = new HttpClient({ retries: 1, retryDelay: 1500 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({ data: 'ok' });

    await run(client.get('https://acme.example.com/api'));

    expect(logger.mock.calls[0][0]).toContain('in 1500ms');
  });

  /**
   * Retry-After may only ever push the retry LATER. A malformed, negative or
   * already-past value parses to 0 ms, and honouring that verbatim discarded the
   * backoff and turned a 429 into an immediate re-request.
   */
  it.each([
    ['a malformed value', 'not-a-date'],
    ['a negative delta', '-30'],
    ['an already-past HTTP-date', 'Wed, 21 Oct 2015 07:28:00 GMT'],
    ['an empty value', '   '],
  ])('keeps the computed backoff for %s', async (_label, header) => {
    const client = new HttpClient({ retries: 1, retryDelay: 2000 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest
      .mockRejectedValueOnce(httpError(429, { 'retry-after': header }))
      .mockResolvedValueOnce({ data: 'ok' });

    await run(client.get('https://acme.example.com/api'));

    expect(logger.mock.calls[0][0]).toContain('in 2000ms');
  });

  it('never retries sooner than the backoff even when the server asks for less', async () => {
    const client = new HttpClient({ retries: 1, retryDelay: 5000 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest
      .mockRejectedValueOnce(httpError(429, { 'retry-after': '1' }))
      .mockResolvedValueOnce({ data: 'ok' });

    await run(client.get('https://acme.example.com/api'));

    expect(logger.mock.calls[0][0]).toContain('in 5000ms');
  });

  it('appends the rate-limit bucket to the retry line (Spec 1690)', async () => {
    const client = new HttpClient({ retries: 1 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest.mockRejectedValueOnce(httpError(502)).mockResolvedValueOnce({ data: 'ok' });

    await run(client.get('https://acme.example.com/api'));

    expect(logger.mock.calls[0][0]).toContain('failed 502, retry 1/1 in 1000ms (host:acme.example.com)');
  });

  it('sends the pre-1690 Chrome/120 User-Agent, even over a UA declared through setHeaders', async () => {
    const client = new HttpClient();
    client.setHeaders({ 'User-Agent': 'Declared/1.0', 'Accept-Language': 'fr-FR' });
    mockAxiosRequest.mockResolvedValueOnce({ data: 'ok' });

    await run(client.get('https://acme.example.com/api'));

    const sent = mockAxiosRequest.mock.calls[0][0];
    expect(sent.headers['User-Agent']).toBe(LEGACY_BROWSER_USER_AGENT);
    expect(client.getAxiosInstance().defaults.headers.common).toEqual({ 'Accept-Language': 'fr-FR' });
  });

  it('retries 3 times by default, linearly, including on 500', async () => {
    const client = new HttpClient();
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce({ data: 'ok' });

    const result = await run(client.get('https://acme.example.com/api'));

    expect(result).toEqual({ data: 'ok' });
    expect(mockAxiosRequest).toHaveBeenCalledTimes(4);
    expect(logger.mock.calls.map((c) => /in (\d+)ms/.exec(c[0] as string)?.[1])).toEqual(['1000', '2000', '3000']);
  });
});

/** The polite default (Spec 1690) keeps the Spec 5085 guarantees with its own arithmetic. */
describe('HttpClient retry attribution — Spec 5085 under the polite default', () => {
  beforeEach(() => {
    mockAxiosRequest.mockReset();
    delete process.env[CRAWL_ENV.PRESET];
    resetCrawlState();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restorePreset();
  });

  async function run<T>(promise: Promise<T>): Promise<T | Error> {
    const settled = promise.catch((err: Error) => err);
    await jest.advanceTimersByTimeAsync(60_000);
    return settled;
  }

  it('names the request and bucket, and sends the honest Ever Jobs User-Agent', async () => {
    const client = new HttpClient({ retries: 1 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest.mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce({ data: 'ok' });

    await runWithRequestId('req-xyz', () => run(client.get('https://acme.example.com/api?token=SECRET')));

    expect(logger.mock.calls[0][0]).toContain('[req-xyz] GET https://acme.example.com/api?token=REDACTED failed 429, retry 1/1 in');
    expect(logger.mock.calls[0][0]).toContain('(host:acme.example.com)');
    expect(mockAxiosRequest.mock.calls[0][0].headers['User-Agent']).toBe(EVER_JOBS_DEFAULT_USER_AGENT);
  });

  it('honours Retry-After (never earlier than asked)', async () => {
    const client = new HttpClient({ retries: 1 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest
      .mockRejectedValueOnce(httpError(429, { 'retry-after': '5' }))
      .mockResolvedValueOnce({ data: 'ok' });

    await run(client.get('https://acme.example.com/api'));

    expect(logger.mock.calls[0][0]).toContain('in 5000ms');
  });

  it('does not retry a 500 (not in the polite retryStatuses)', async () => {
    const client = new HttpClient();
    mockAxiosRequest.mockRejectedValueOnce(httpError(500));

    const result = await run(client.get('https://acme.example.com/api'));

    expect((result as Error).message).toContain('status code 500');
    expect(mockAxiosRequest).toHaveBeenCalledTimes(1);
  });
});

/**
 * Naming the request made the retry line attributable, but several sources
 * authenticate by query parameter, so the same line would have written their
 * credentials into the logs.
 */
describe('HttpClient retry log URL redaction', () => {
  beforeEach(() => {
    mockAxiosRequest.mockReset();
    resetCrawlState();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    restorePreset();
  });

  /** Retry once against `url` and return the warn line it logged. */
  async function warnLineFor(url: string): Promise<string> {
    const client = new HttpClient({ retries: 1 });
    const logger = jest.spyOn((client as any).logger, 'warn').mockImplementation(() => undefined);
    mockAxiosRequest
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValueOnce({ data: 'ok' });

    const settled = client.get(url).catch((err: Error) => err);
    await jest.advanceTimersByTimeAsync(60_000);
    await settled;

    return logger.mock.calls[0][0] as string;
  }

  it.each([
    ['apikey', 'https://api.resumatorapi.com/v1/jobs?apikey=SECRET-VALUE'],
    ['token', 'https://api.comeet.co/careers/v1/positions?token=SECRET-VALUE'],
    ['api_key', 'https://api.example-ats.com/v1/jobs?api_key=SECRET-VALUE'],
    ['access_token', 'https://acme.example.com/v1/jobs?access_token=SECRET-VALUE'],
  ])('redacts a %s query parameter', async (key, url) => {
    const line = await warnLineFor(url);

    expect(line).not.toContain('SECRET-VALUE');
    expect(line).toContain(`${key}=REDACTED`);
  });

  it('keeps the non-credential parameters that make the line attributable', async () => {
    const line = await warnLineFor(
      'https://api.resumatorapi.com/v1/jobs?company=acme&apikey=SECRET-VALUE&page=3',
    );

    expect(line).not.toContain('SECRET-VALUE');
    expect(line).toContain('https://api.resumatorapi.com/v1/jobs?company=acme&apikey=REDACTED&page=3');
  });

  it('leaves a URL without a query string untouched', async () => {
    const line = await warnLineFor('https://acme.example.com/wday/cxs/acme/Careers/job/R-1');

    expect(line).toContain('GET https://acme.example.com/wday/cxs/acme/Careers/job/R-1 failed 429');
  });

  it('preserves the fragment while redacting the query', async () => {
    const line = await warnLineFor('https://acme.example.com/jobs?token=SECRET-VALUE#results');

    expect(line).not.toContain('SECRET-VALUE');
    expect(line).toContain('https://acme.example.com/jobs?token=REDACTED#results');
  });

  /**
   * Ceipal carries the tenant key as the first path segment rather than a query
   * parameter (`CeipalService.fetchListPage` builds
   * `https://api.ceipal.com/{apiKey}/job-postings/`), and the service masks it
   * in its own logs — the shared retry line must not undo that.
   */
  it('redacts the Ceipal tenant key carried as a path segment', async () => {
    const line = await warnLineFor('https://api.ceipal.com/deadbeefkey/job-postings/');

    expect(line).not.toContain('deadbeefkey');
    expect(line).toContain('https://api.ceipal.com/REDACTED/job-postings/');
  });

  it('redacts a Ceipal path key alongside a query string', async () => {
    const line = await warnLineFor('https://api.ceipal.com/deadbeefkey/job-postings/?page=2');

    expect(line).not.toContain('deadbeefkey');
    expect(line).toContain('https://api.ceipal.com/REDACTED/job-postings/?page=2');
  });

  it('leaves the first path segment of every other host alone', async () => {
    const line = await warnLineFor('https://boards.greenhouse.io/acme/jobs/42');

    expect(line).toContain('https://boards.greenhouse.io/acme/jobs/42');
  });

  it('redacts the Ceipal key when the URL carries a port', async () => {
    const line = await warnLineFor('https://api.ceipal.com:443/deadbeefkey/job-postings/');

    expect(line).not.toContain('deadbeefkey');
    expect(line).toContain('https://api.ceipal.com:443/REDACTED/job-postings/');
  });

  it('leaves a bare Ceipal origin with no key alone', async () => {
    const line = await warnLineFor('https://api.ceipal.com/');

    expect(line).toContain('GET https://api.ceipal.com/ failed 429');
  });
});

/**
 * `HttpClientOptions` mixes units -- `timeout` is seconds while `retryDelay` and
 * `retryMaxDelay` are milliseconds -- and only the rate-delay pair said so. Two
 * plugins had already written `timeout: 10000` meaning 10s and silently got
 * ~2.8 hours, which turns a hung host into a request that can only ever be
 * killed from outside. These pin the contract so a "helpful" unit change to
 * either side breaks loudly instead of silently.
 */
describe('HttpClientOptions unit contract', () => {
  const created = () => (axios.create as jest.Mock).mock.calls.at(-1)![0];

  beforeEach(() => (axios.create as jest.Mock).mockClear());

  it('reads timeout as SECONDS and hands axios milliseconds', () => {
    new HttpClient({ timeout: 10 });

    expect(created().timeout).toBe(10_000);
  });

  it('defaults to 60 seconds when timeout is omitted', () => {
    new HttpClient({});

    expect(created().timeout).toBe(60_000);
  });

  it('shows why `timeout: 10000` is the bug it does not look like', () => {
    new HttpClient({ timeout: 10_000 });

    // 10_000 seconds -- nearly three hours, not the ten seconds it reads as.
    expect(created().timeout).toBe(10_000_000);
    expect(created().timeout).toBeGreaterThan(2 * 60 * 60 * 1000);
  });

  it('reads rateDelayMin/Max as SECONDS', () => {
    const client = new HttpClient({ rateDelayMin: 2, rateDelayMax: 3 });

    expect((client as any).rateDelayMin).toBe(2000);
    expect((client as any).rateDelayMax).toBe(3000);
  });

  it('reads retryDelay and retryMaxDelay as MILLISECONDS, unlike timeout', () => {
    const client = new HttpClient({ retryDelay: 1500, retryMaxDelay: 20_000 });

    expect((client as any).retryDelay).toBe(1500);
    expect((client as any).retryMaxDelay).toBe(20_000);
  });

  /** Spec 1690 §4.1 — the same units, carried into the crawl policy's plugin layer. */
  it('maps the options onto crawl-policy milliseconds', () => {
    const client = new HttpClient({
      rateDelayMin: 2,
      rateDelayMax: 3,
      retryDelay: 1500,
      retryMaxDelay: 20_000,
      retries: 4,
      retryBackoff: 'exponential',
    });

    expect((client as any).explicit).toEqual({
      minIntervalMs: 2000,
      jitterMs: 1000,
      retryBaseDelayMs: 1500,
      retryMaxDelayMs: 20_000,
      retries: 4,
      retryBackoff: 'exponential',
    });
  });

  it('puts no User-Agent into the instance defaults (the interceptor sets it per request)', () => {
    new HttpClient({ userAgent: 'Declared/1.0' });

    expect(created().headers).toBeUndefined();
  });
});
