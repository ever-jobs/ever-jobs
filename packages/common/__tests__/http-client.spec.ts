import 'reflect-metadata';

const mockAxiosRequest = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      request: mockAxiosRequest,
      defaults: { headers: { common: {} } },
    })),
  },
}));

import axios from 'axios';
import { HttpClient } from '../src/http/http-client';
import { runWithRequestId } from '../src/context';

function httpError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, headers },
  });
}

/**
 * Spec 5085 — a retry log line that does not name its own request cannot be
 * attributed to anything, and a 429 must honor the pause the server asked for.
 */
describe('HttpClient retry attribution and Retry-After — Spec 5085', () => {
  beforeEach(() => {
    mockAxiosRequest.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
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
});

/**
 * Naming the request made the retry line attributable, but several sources
 * authenticate by query parameter, so the same line would have written their
 * credentials into the logs.
 */
describe('HttpClient retry log URL redaction', () => {
  beforeEach(() => {
    mockAxiosRequest.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
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
});
