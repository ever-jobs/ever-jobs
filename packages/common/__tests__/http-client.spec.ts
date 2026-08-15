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
