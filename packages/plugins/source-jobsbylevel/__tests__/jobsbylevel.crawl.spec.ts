import 'reflect-metadata';
import { SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { Site } from '@ever-jobs/models';
import { explainCrawlPolicy, readCrawlPolicyEnv } from '@ever-jobs/common';
import { JobsByLevelService } from '../src/jobsbylevel.service';
import { JOBSBYLEVEL_CRAWL_POLICY, JOBSBYLEVEL_MIN_INTERVAL_MS } from '../src/jobsbylevel.constants';

/**
 * Level's crawl manifest (Spec 1690 `@SourcePlugin({ crawl })`), declaring the
 * pacing its own design called for: one request in flight, at least 1.1 s apart (Spec 1693 D-12).
 * Pacing only: the identity stays with the global policy (no `userAgentMode` opt-in).
 */

const manifest = () => Reflect.getMetadata(SOURCE_PLUGIN_METADATA, JobsByLevelService);

describe('Level crawl manifest (Spec 1690 x Spec 1693)', () => {
  it('declares the designed pacing and nothing else', () => {
    expect(manifest()).toMatchObject({ site: Site.JOBSBYLEVEL, crawl: JOBSBYLEVEL_CRAWL_POLICY });
    expect(JOBSBYLEVEL_CRAWL_POLICY).toEqual({ maxConcurrentPerHost: 1, minIntervalMs: JOBSBYLEVEL_MIN_INTERVAL_MS });
    expect(Object.keys(JOBSBYLEVEL_CRAWL_POLICY).sort()).toEqual(['maxConcurrentPerHost', 'minIntervalMs']);
  });

  it('resolves under the default preset with the plugin layer as provenance', () => {
    const { policy } = explainCrawlPolicy({ site: Site.JOBSBYLEVEL, plugin: manifest().crawl }, readCrawlPolicyEnv({}));

    expect(policy.maxConcurrentPerHost).toBe(JOBSBYLEVEL_CRAWL_POLICY.maxConcurrentPerHost);
    expect(policy.minIntervalMs).toBe(JOBSBYLEVEL_CRAWL_POLICY.minIntervalMs);
    expect(policy.provenance.maxConcurrentPerHost).toBe('plugin');
    expect(policy.provenance.minIntervalMs).toBe('plugin');
    expect(policy.userAgentMode).toBe('identify');
  });

  it('an operator site policy overrides it', () => {
    const env = readCrawlPolicyEnv({
      EVER_JOBS_CRAWL_POLICIES: JSON.stringify({ sites: { jobsbylevel: { minIntervalMs: 9000 } } }),
    });
    const { policy } = explainCrawlPolicy({ site: Site.JOBSBYLEVEL, plugin: manifest().crawl }, env);

    expect(policy.minIntervalMs).toBe(9000);
    expect(policy.provenance.minIntervalMs).toBe('operator-site');
  });
});
