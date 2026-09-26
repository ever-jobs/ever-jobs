import 'reflect-metadata';
import { SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { Site } from '@ever-jobs/models';
import { explainCrawlPolicy, readCrawlPolicyEnv } from '@ever-jobs/common';
import { SimplifyJobsService } from '../src/simplifyjobs.service';
import { SIMPLIFYJOBS_CRAWL_POLICY, SIMPLIFYJOBS_MIN_INTERVAL_S } from '../src/simplifyjobs.constants';

/**
 * Simplify's crawl manifest (Spec 1690 `@SourcePlugin({ crawl })`), declaring the
 * pacing its own design called for: sequential fetches at least 2 s apart (Spec 1694 D-10/D-11).
 * Pacing only: the identity stays with the global policy (no `userAgentMode` opt-in).
 */

const manifest = () => Reflect.getMetadata(SOURCE_PLUGIN_METADATA, SimplifyJobsService);

describe('Simplify crawl manifest (Spec 1690 x Spec 1694)', () => {
  it('declares the designed pacing and nothing else', () => {
    expect(manifest()).toMatchObject({ site: Site.SIMPLIFYJOBS, crawl: SIMPLIFYJOBS_CRAWL_POLICY });
    expect(SIMPLIFYJOBS_CRAWL_POLICY).toEqual({ maxConcurrentPerHost: 1, minIntervalMs: SIMPLIFYJOBS_MIN_INTERVAL_S * 1000 });
    expect(Object.keys(SIMPLIFYJOBS_CRAWL_POLICY).sort()).toEqual(['maxConcurrentPerHost', 'minIntervalMs']);
  });

  it('resolves under the default preset with the plugin layer as provenance', () => {
    const { policy } = explainCrawlPolicy({ site: Site.SIMPLIFYJOBS, plugin: manifest().crawl }, readCrawlPolicyEnv({}));

    expect(policy.maxConcurrentPerHost).toBe(SIMPLIFYJOBS_CRAWL_POLICY.maxConcurrentPerHost);
    expect(policy.minIntervalMs).toBe(SIMPLIFYJOBS_CRAWL_POLICY.minIntervalMs);
    expect(policy.provenance.maxConcurrentPerHost).toBe('plugin');
    expect(policy.provenance.minIntervalMs).toBe('plugin');
    expect(policy.userAgentMode).toBe('identify');
  });

  it('an operator site policy overrides it', () => {
    const env = readCrawlPolicyEnv({
      EVER_JOBS_CRAWL_POLICIES: JSON.stringify({ sites: { simplifyjobs: { minIntervalMs: 9000 } } }),
    });
    const { policy } = explainCrawlPolicy({ site: Site.SIMPLIFYJOBS, plugin: manifest().crawl }, env);

    expect(policy.minIntervalMs).toBe(9000);
    expect(policy.provenance.minIntervalMs).toBe('operator-site');
  });
});
