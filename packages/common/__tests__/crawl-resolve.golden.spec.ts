import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CRAWL_ENV } from '../src/http/crawl/defaults';
import { readCrawlPolicyEnv } from '../src/http/crawl/env';
import { explainCrawlPolicy } from '../src/http/crawl/resolve';
import { CrawlPolicyOverride, CrawlPolicyResolveInput, PluginCrawlPolicy } from '../src/http/crawl/types';

/**
 * Spec 1714 FR-17 (T01): sources WITHOUT a caller lock resolve exactly as they did
 * before Spec 1714 under the default `EVER_JOBS_CRAWL_CALLER_OVERRIDES=any` (and
 * under `none`): the Spec 1690 policy fields, their provenance and the refused
 * caller fields.
 *
 * The fixture was captured from the code BEFORE any Spec 1714 resolver change
 * (its `$capturedOn` names the commit). Re-capture only on purpose:
 * `UPDATE_GOLDEN=1 npx jest --testPathPatterns crawl-resolve.golden`.
 *
 * Only the keys captured in the fixture are compared: fields added later (Spec
 * 1714 `minGapMs`, `serverErrorCooldownMs`) are ignored, so the test pins the old
 * behaviour and nothing else.
 */

const FIXTURE = join(__dirname, 'fixtures', 'crawl-resolve-golden-1690.json');

/** Inline copy of the USAJobs manifest (a plugin UA opt-in, no lock). */
const USAJOBS_MANIFEST: PluginCrawlPolicy = {
  userAgentMode: 'plugin',
  userAgentReason:
    'The USAJobs Search API requires the User-Agent header to be the e-mail address registered with the API key (developer.usajobs.gov).',
};

/** A multi-tenant manifest without a lock (the shape of the Softy manifest before Spec 1715). */
const DOMAIN_MANIFEST: PluginCrawlPolicy = { rateLimitScope: 'domain', maxConcurrentPerHost: 1 };

/** Every field a caller could use to make traffic less polite (G0, G3, G5, G9, G12, G22). */
const BROAD_CALLER: CrawlPolicyOverride = {
  userAgent: 'browser',
  proxyRotation: 'per-request',
  rateLimitScope: 'site',
  minIntervalMs: 0,
  retries: 5,
  retryStatuses: [500],
  discovery: 'listing',
};

const SOURCES: ReadonlyArray<{ name: string; input: CrawlPolicyResolveInput }> = [
  { name: 'linkedin', input: { site: 'linkedin', host: 'www.linkedin.com' } },
  { name: 'greenhouse', input: { site: 'greenhouse', host: 'boards-api.greenhouse.io' } },
  { name: 'usajobs', input: { site: 'usajobs', host: 'data.usajobs.gov', plugin: USAJOBS_MANIFEST } },
  { name: 'liveness-http', input: { site: 'liveness-http', host: 'jobs.example.com' } },
  { name: 'domain-manifest', input: { site: 'acme-ats', host: 'tenant.acme-ats.example.com', plugin: DOMAIN_MANIFEST } },
];

const CALLERS: ReadonlyArray<{ name: string; caller?: CrawlPolicyOverride }> = [
  { name: 'no caller' },
  { name: 'broad caller', caller: BROAD_CALLER },
];

const MODES: ReadonlyArray<{ name: string; vars: Record<string, string> }> = [
  { name: 'default (any)', vars: {} },
  { name: 'none', vars: { [CRAWL_ENV.CALLER_OVERRIDES]: 'none' } },
];

interface GoldenCase {
  key: string;
  fields: Record<string, unknown>;
  provenance: Record<string, unknown>;
  callerRejected: string[];
}

interface GoldenFile {
  $capturedOn: string;
  $comment: string;
  fields: string[];
  cases: GoldenCase[];
}

/** The Spec 1690 policy field names (captured with the fixture; later fields are not compared). */
const FIELDS_1690 = [
  'userAgent',
  'userAgentMode',
  'from',
  'stripClientHints',
  'proxyRotation',
  'rateLimitScope',
  'maxConcurrentPerHost',
  'minIntervalMs',
  'jitterMs',
  'maxQueueWaitMs',
  'adaptiveThrottle',
  'retries',
  'retryStatuses',
  'retryBackoff',
  'retryBaseDelayMs',
  'retryMaxDelayMs',
  'retryJitter',
  'retryOnNetworkError',
  'respectRetryAfter',
  'maxRetryAfterMs',
  'retryAfterOverMax',
  'throttleRetryDelayMs',
  'robotsTxt',
  'blockPrivateNetworks',
  'discovery',
] as const;

function capture(fields: readonly string[]): GoldenCase[] {
  const out: GoldenCase[] = [];
  for (const mode of MODES) {
    const env = readCrawlPolicyEnv(mode.vars as NodeJS.ProcessEnv);
    for (const source of SOURCES) {
      for (const call of CALLERS) {
        const explained = explainCrawlPolicy({ ...source.input, caller: call.caller }, env);
        const policy = explained.policy as unknown as Record<string, unknown>;
        const provenance = explained.policy.provenance as Record<string, unknown>;
        const pick = (record: Record<string, unknown>) =>
          Object.fromEntries(fields.filter((f) => record[f] !== undefined).map((f) => [f, record[f]]));
        out.push({
          key: `${mode.name} | ${source.name} | ${call.name}`,
          fields: pick(policy),
          provenance: pick(provenance),
          callerRejected: [...explained.callerRejected].sort(),
        });
      }
    }
  }
  return out;
}

describe('crawl policy resolution golden (Spec 1714 FR-17: sources without a lock are unchanged)', () => {
  if (process.env.UPDATE_GOLDEN === '1') {
    it('writes the golden fixture', () => {
      const dir = join(__dirname, 'fixtures');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const golden: GoldenFile = {
        $capturedOn: process.env.GOLDEN_COMMIT ?? 'unknown commit',
        $comment:
          'Spec 1714 T01: explainCrawlPolicy of sources without a caller lock, captured before any Spec 1714 resolver change.',
        fields: [...FIELDS_1690],
        cases: capture(FIELDS_1690),
      };
      writeFileSync(FIXTURE, `${JSON.stringify(golden, null, 2)}\n`, 'utf8');
      expect(golden.cases.length).toBe(MODES.length * SOURCES.length * CALLERS.length);
    });
    return;
  }

  const golden = JSON.parse(readFileSync(FIXTURE, 'utf8')) as GoldenFile;
  const current = new Map(capture(golden.fields).map((c) => [c.key, c]));

  it('the fixture covers every (mode, source, caller) case', () => {
    expect(golden.cases.map((c) => c.key).sort()).toEqual([...current.keys()].sort());
  });

  it.each(golden.cases.map((c) => [c.key, c] as const))('%s', (_key, expected) => {
    const actual = current.get(expected.key);
    expect(actual).toBeDefined();
    expect(actual?.fields).toEqual(expected.fields);
    expect(actual?.provenance).toEqual(expected.provenance);
    expect(actual?.callerRejected).toEqual(expected.callerRejected);
  });
});
