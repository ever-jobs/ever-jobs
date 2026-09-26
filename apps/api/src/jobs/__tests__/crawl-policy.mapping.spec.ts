import 'reflect-metadata';
import { CrawlPolicyDto, ScraperInputDto } from '@ever-jobs/models';
import { buildCallerCrawlOverride, legacyCrawlOverride } from '../crawl-policy.mapping';

/**
 * Spec 1690 §4.1 — the caller layer is built ONLY from what the caller sent:
 * the pre-1690 flat DTO fields (mapped) plus the `crawl` object.
 */
describe('legacyCrawlOverride (Spec 1690 §4.1)', () => {
  it('maps nothing when the caller sent none of the legacy fields', () => {
    expect(legacyCrawlOverride({})).toEqual({ value: {}, warnings: [] });
    // The ScraperInputDto constructor defaults (requestTimeout, resultsWanted…)
    // are not crawl fields and must not produce overrides either.
    expect(legacyCrawlOverride(new ScraperInputDto())).toEqual({ value: {}, warnings: [] });
  });

  it('userAgent → userAgent + userAgentMode strict (their UA is what goes out)', () => {
    expect(legacyCrawlOverride({ userAgent: 'AcmeBot/1.0' }).value).toEqual({
      userAgent: 'AcmeBot/1.0',
      userAgentMode: 'strict',
    });
  });

  it('userAgent does not force strict when crawl.userAgentMode is also set', () => {
    const crawl = Object.assign(new CrawlPolicyDto(), { userAgentMode: 'plugin' as const });
    expect(legacyCrawlOverride({ userAgent: 'AcmeBot/1.0', crawl }).value).toEqual({
      userAgent: 'AcmeBot/1.0',
    });
  });

  it('ignores an empty userAgent with a warning', () => {
    const { value, warnings } = legacyCrawlOverride({ userAgent: '   ' });
    expect(value).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  it('rateDelayMin/Max (seconds) → minIntervalMs = min×1000, jitterMs = (max−min)×1000', () => {
    expect(legacyCrawlOverride({ rateDelayMin: 1.5, rateDelayMax: 4 }).value).toEqual({
      minIntervalMs: 1500,
      jitterMs: 2500,
    });
  });

  it('rateDelayMin alone → minIntervalMs only', () => {
    expect(legacyCrawlOverride({ rateDelayMin: 2 }).value).toEqual({ minIntervalMs: 2000 });
  });

  it('rateDelayMax alone → jitterMs = max×1000 (min taken as 0), no minIntervalMs', () => {
    expect(legacyCrawlOverride({ rateDelayMax: 0.3 }).value).toEqual({ jitterMs: 300 });
  });

  it('a max below the min gives no jitter; negatives clamp to 0', () => {
    expect(legacyCrawlOverride({ rateDelayMin: 2, rateDelayMax: 1 }).value).toEqual({
      minIntervalMs: 2000,
      jitterMs: 0,
    });
    expect(legacyCrawlOverride({ rateDelayMin: -1 }).value).toEqual({ minIntervalMs: 0 });
  });

  it('an explicit 0 is a value the caller sent (not "unset")', () => {
    expect(legacyCrawlOverride({ rateDelayMin: 0, retries: 0 }).value).toEqual({
      minIntervalMs: 0,
      retries: 0,
    });
  });

  it('retries / retryDelay / retryBackoff / retryMaxDelay → retries / retryBaseDelayMs / retryBackoff / retryMaxDelayMs', () => {
    expect(
      legacyCrawlOverride({ retries: 1.9, retryDelay: 250, retryBackoff: 'exponential', retryMaxDelay: 5000 }).value,
    ).toEqual({ retries: 1, retryBaseDelayMs: 250, retryBackoff: 'exponential', retryMaxDelayMs: 5000 });
    expect(legacyCrawlOverride({ retryBackoff: 'linear' }).value).toEqual({ retryBackoff: 'linear' });
  });

  it('skips unmappable values with warnings instead of throwing', () => {
    const { value, warnings } = legacyCrawlOverride({
      retries: Number.NaN,
      rateDelayMin: Number.POSITIVE_INFINITY,
      retryBackoff: 'fibonacci' as never,
      retryDelay: 'soon' as never,
    });
    expect(value).toEqual({});
    expect(warnings).toHaveLength(4);
  });
});

describe('buildCallerCrawlOverride (Spec 1690 §4.1)', () => {
  it('returns no override when the caller set nothing', () => {
    expect(buildCallerCrawlOverride(new ScraperInputDto({ searchTerm: 'x' }))).toEqual({ warnings: [] });
    expect(buildCallerCrawlOverride({ crawl: new CrawlPolicyDto() })).toEqual({ warnings: [] });
  });

  it('merges the legacy fields and crawl, crawl winning where both set a field', () => {
    const { override } = buildCallerCrawlOverride({
      rateDelayMin: 1,
      retries: 5,
      crawl: Object.assign(new CrawlPolicyDto(), { minIntervalMs: 3000, maxConcurrentPerHost: 1, discovery: 'sitemap' as const }),
    });
    expect(override).toEqual({ minIntervalMs: 3000, retries: 5, maxConcurrentPerHost: 1, discovery: 'sitemap' });
  });

  it('crawl fields left undefined never shadow a legacy value', () => {
    const crawl = Object.assign(new CrawlPolicyDto(), { minIntervalMs: undefined, retries: 2 });
    expect(buildCallerCrawlOverride({ rateDelayMin: 1, crawl }).override).toEqual({
      minIntervalMs: 1000,
      retries: 2,
    });
  });

  it('validates the merged override (unknown keys and bad values dropped with warnings)', () => {
    const { override, warnings } = buildCallerCrawlOverride({
      crawl: { maxConcurrentPerHost: 2, notAKnob: 1, proxyRotation: 'sideways' } as unknown as CrawlPolicyDto,
    });
    expect(override).toEqual({ maxConcurrentPerHost: 2 });
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a non-object crawl', () => {
    const { override, warnings } = buildCallerCrawlOverride({ crawl: 'polite' as unknown as CrawlPolicyDto });
    expect(override).toBeUndefined();
    expect(warnings).toEqual(['ignored crawl: expected an object']);
  });
});
