import 'reflect-metadata';
import { SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { Site } from '@ever-jobs/models';
import { explainCrawlPolicy, readCrawlPolicyEnv } from '@ever-jobs/common';
import { InhireService } from '../src/inhire.service';
import { INHIRE_CRAWL_POLICY, INHIRE_MAX_DETAIL_CONCURRENCY, INHIRE_MIN_INTERVAL_MS } from '../src/inhire.constants';

/**
 * InHire's crawl manifest (Spec 1690 `@SourcePlugin({ crawl })`), declaring the
 * pacing its own design called for: every tenant shares one API host: requests at least 500 ms apart, at most two in flight (Spec 1692 §10).
 * Pacing only: the identity stays with the global policy (no `userAgentMode` opt-in).
 */

const manifest = () => Reflect.getMetadata(SOURCE_PLUGIN_METADATA, InhireService);

describe('InHire crawl manifest (Spec 1690 x Spec 1692)', () => {
  it('declares the designed pacing and nothing else', () => {
    expect(manifest()).toMatchObject({ site: Site.INHIRE, crawl: INHIRE_CRAWL_POLICY });
    expect(INHIRE_CRAWL_POLICY).toEqual({ maxConcurrentPerHost: INHIRE_MAX_DETAIL_CONCURRENCY, minIntervalMs: INHIRE_MIN_INTERVAL_MS });
    expect(Object.keys(INHIRE_CRAWL_POLICY).sort()).toEqual(['maxConcurrentPerHost', 'minIntervalMs']);
  });

  it('resolves under the default preset with the plugin layer as provenance', () => {
    const { policy } = explainCrawlPolicy({ site: Site.INHIRE, plugin: manifest().crawl }, readCrawlPolicyEnv({}));

    expect(policy.maxConcurrentPerHost).toBe(INHIRE_CRAWL_POLICY.maxConcurrentPerHost);
    expect(policy.minIntervalMs).toBe(INHIRE_CRAWL_POLICY.minIntervalMs);
    expect(policy.provenance.maxConcurrentPerHost).toBe('plugin');
    expect(policy.provenance.minIntervalMs).toBe('plugin');
    expect(policy.userAgentMode).toBe('identify');
  });

  it('an operator site policy overrides it', () => {
    const env = readCrawlPolicyEnv({
      EVER_JOBS_CRAWL_POLICIES: JSON.stringify({ sites: { inhire: { minIntervalMs: 9000 } } }),
    });
    const { policy } = explainCrawlPolicy({ site: Site.INHIRE, plugin: manifest().crawl }, env);

    expect(policy.minIntervalMs).toBe(9000);
    expect(policy.provenance.minIntervalMs).toBe('operator-site');
  });
});
