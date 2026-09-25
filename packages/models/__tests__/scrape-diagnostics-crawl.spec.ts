import {
  ACTIONABLE_SCRAPE_REASONS,
  CRAWL_ERROR_SCRAPE_REASONS,
  classifyScrapeError,
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
