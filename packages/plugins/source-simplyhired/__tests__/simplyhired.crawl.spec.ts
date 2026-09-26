import 'reflect-metadata';
import { SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { Site } from '@ever-jobs/models';
import { explainCrawlPolicy, readCrawlPolicyEnv } from '@ever-jobs/common';
import { SimplyHiredService } from '../src/simplyhired.service';
import { SIMPLYHIRED_CRAWL_POLICY } from '../src/simplyhired.constants';

/**
 * SimplyHired's crawl-policy opt-in (Spec 1690 §4.2): the site 403s the Ever Jobs
 * UA (live A/B 2026-09-25), so the plugin keeps its declared browser UA under
 * the default `identify` mode — and only that; pacing stays global.
 */
const manifest = () => Reflect.getMetadata(SOURCE_PLUGIN_METADATA, SimplyHiredService);

describe('SimplyHired crawl policy (Spec 1690)', () => {
  it('declares a userAgentMode "plugin" opt-in with an evidence-based reason', () => {
    expect(manifest()).toMatchObject({ site: Site.SIMPLYHIRED, crawl: SIMPLYHIRED_CRAWL_POLICY });
    expect(manifest().crawl).toEqual({
      userAgentMode: 'plugin',
      userAgentReason: expect.stringMatching(/403.*Ever Jobs User-Agent/),
    });
  });

  it('opts into nothing but the UA mode', () => {
    expect(Object.keys(SIMPLYHIRED_CRAWL_POLICY).sort()).toEqual(['userAgentMode', 'userAgentReason']);
  });

  it('resolves to mode "plugin" (provenance plugin) under the default identify policy', () => {
    const explanation = explainCrawlPolicy({ site: Site.SIMPLYHIRED, plugin: manifest().crawl }, readCrawlPolicyEnv({}));
    expect(explanation.policy.userAgentMode).toBe('plugin');
    expect(explanation.policy.provenance.userAgentMode).toBe('plugin');
    expect(explanation.userAgentReason).toBe(SIMPLYHIRED_CRAWL_POLICY.userAgentReason);
  });

  it('is ignored when the operator pins EVER_JOBS_CRAWL_USER_AGENT_MODE=strict', () => {
    const env = readCrawlPolicyEnv({ EVER_JOBS_CRAWL_USER_AGENT_MODE: 'strict' });
    const explanation = explainCrawlPolicy({ site: Site.SIMPLYHIRED, plugin: manifest().crawl }, env);
    expect(explanation.policy.userAgentMode).toBe('strict');
    expect(explanation.userAgentReason).toBeUndefined();
  });
});
