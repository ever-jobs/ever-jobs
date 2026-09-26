import {
  ACTIONABLE_SCRAPE_REASONS,
  CRAWL_ERROR_SCRAPE_REASONS,
  ScrapeDiagnostics,
  classifyScrapeError,
  isRefusalDiagnostics,
  refusalFromScrapeError,
} from '../src/dtos/scrape-diagnostics.dto';
// The real error classes, so a renamed `code` breaks this test instead of the mapping silently.
import {
  CrawlQueueTimeoutError,
  EgressBlockedError,
  HostCoolingDownError,
  RobotsDisallowedError,
} from '../../common/src/http/crawl/errors';

/**
 * Spec 1690 §4.9 — crawl-policy refusals get a reason that says *why*, matched on
 * the stable error code. Their messages contain words ("timeout", "429",
 * "blocked") that the text rules would otherwise misread.
 */
describe('classifyScrapeError — crawl-policy errors (Spec 1690)', () => {
  it('a rate-limit slot not granted in time is rate_limited, not timeout', () => {
    const d = classifyScrapeError(new CrawlQueueTimeoutError('host:acme.softy.pro', 30_000));

    expect(d.reason).toBe('rate_limited');
    expect(d.detail).toContain('host:acme.softy.pro');
  });

  it('a host cooling down after a long Retry-After is rate_limited, not fetch_error', () => {
    expect(classifyScrapeError(new HostCoolingDownError('host:acme.softy.pro', 120_000, 429)).reason).toBe('rate_limited');
  });

  it('a robots.txt refusal is blocked', () => {
    expect(classifyScrapeError(new RobotsDisallowedError('https://acme.example.com/private')).reason).toBe('blocked');
  });

  it('an egress refusal is bad_input, not blocked', () => {
    expect(classifyScrapeError(new EgressBlockedError('127.0.0.1', 'private, loopback or reserved address')).reason).toBe('bad_input');
  });

  it('finds the code on a wrapping error (e.g. an AxiosError whose cause is the refusal)', () => {
    const wrapped = Object.assign(new Error('Refusing to connect'), {
      code: 'ERR_FR_REDIRECTION_FAILURE',
      cause: Object.assign(new Error('Redirected request failed'), {
        cause: new EgressBlockedError('10.0.0.1', 'resolves to private address 10.0.0.1'),
      }),
    });
    expect(classifyScrapeError(wrapped).reason).toBe('bad_input');
    expect(classifyScrapeError({ code: 'ERR_CRAWL_HOST_COOLING_DOWN' }).reason).toBe('rate_limited');
  });

  it('maps exactly the four stable codes, and rate_limited is actionable', () => {
    expect(CRAWL_ERROR_SCRAPE_REASONS).toEqual({
      [new CrawlQueueTimeoutError('b', 1).code]: 'rate_limited',
      [new HostCoolingDownError('b', 1).code]: 'rate_limited',
      [new RobotsDisallowedError('u').code]: 'blocked',
      [new EgressBlockedError('t', 'r').code]: 'bad_input',
    });
    expect(ACTIONABLE_SCRAPE_REASONS).toContain('rate_limited');
  });

  it('leaves the existing rules alone for everything else', () => {
    expect(classifyScrapeError(new Error('Request failed with status code 429')).reason).toBe('fetch_error');
    expect(classifyScrapeError(Object.assign(new Error('x'), { code: 'ERR_SOMETHING_ELSE' })).reason).toBe('unknown');
  });
});

/**
 * Spec 1700 review fixup x Spec 1690 — the refusal helpers plugins use to stop a
 * detail walk (and the multi-location loop uses to stop a source's remaining
 * locations) treat the crawl policy's own hold-back like a 429.
 */
function httpError(status: number): Error & { response: { status: number } } {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
}

describe('refusalFromScrapeError / isRefusalDiagnostics (Specs 1700, 1690)', () => {
  it('a host cooling down or a queue timeout is a rate_limited refusal', () => {
    expect(refusalFromScrapeError(new HostCoolingDownError('host:a.example', 120_000, 429))?.reason).toBe('rate_limited');
    expect(refusalFromScrapeError(new CrawlQueueTimeoutError('host:a.example', 30_000))?.reason).toBe('rate_limited');
  });

  it('a robots.txt refusal is a blocked refusal; an egress refusal is not a refusal', () => {
    expect(refusalFromScrapeError(new RobotsDisallowedError('https://a.example/x'))?.reason).toBe('blocked');
    expect(refusalFromScrapeError(new EgressBlockedError('127.0.0.1', 'loopback'))).toBeNull();
  });

  it('keeps the HTTP rules: 429 fetch_error, 401/403/407 blocked, 404 and 5xx not refusals', () => {
    expect(refusalFromScrapeError(httpError(429))?.reason).toBe('fetch_error');
    for (const status of [401, 403, 407]) expect(refusalFromScrapeError(httpError(status))?.reason).toBe('blocked');
    expect(refusalFromScrapeError(httpError(404))).toBeNull();
    expect(refusalFromScrapeError(httpError(503))).toBeNull();
  });

  it('isRefusalDiagnostics accepts rate_limited, blocked, circuit_open and a rate-limit fetch_error', () => {
    expect(isRefusalDiagnostics(new ScrapeDiagnostics('rate_limited', 'slot not granted'))).toBe(true);
    expect(isRefusalDiagnostics(new ScrapeDiagnostics('blocked'))).toBe(true);
    expect(isRefusalDiagnostics(new ScrapeDiagnostics('circuit_open'))).toBe(true);
    expect(isRefusalDiagnostics(new ScrapeDiagnostics('fetch_error', 'HTTP 429 Too Many Requests'))).toBe(true);
    expect(isRefusalDiagnostics(new ScrapeDiagnostics('fetch_error', 'HTTP 500'))).toBe(false);
    expect(isRefusalDiagnostics(null)).toBe(false);
  });
});
