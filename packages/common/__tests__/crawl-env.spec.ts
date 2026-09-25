import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';

import {
  CRAWL_ENV,
  CRAWL_PRESETS,
  EVER_JOBS_DEFAULT_USER_AGENT,
  LEGACY_BROWSER_USER_AGENT,
} from '../src/http/crawl/defaults';
import {
  CRAWL_EXTRA_ENV,
  CRAWL_POLICY_ENV_VARS,
  LEGACY_RETRY_ENV,
  crawlBuiltinHostsEnabled,
  crawlCallerProxiesAllowed,
  crawlPluginManifestsEnabled,
  expandUserAgent,
  parseCrawlProxyList,
  readCrawlPolicyEnv,
  resetCrawlPolicyEnvCache,
} from '../src/http/crawl/env';
import { CrawlPolicy } from '../src/http/crawl/types';

/** Spec 1690 §5.1 — every EVER_JOBS_CRAWL_* variable, valid and invalid. */
describe('crawl policy env (Spec 1690)', () => {
  const parse = (vars: Record<string, string>) => readCrawlPolicyEnv(vars as NodeJS.ProcessEnv);

  describe('defaults', () => {
    it('an empty environment yields the polite preset and no overrides', () => {
      const cfg = parse({});
      expect(cfg).toEqual({
        preset: 'polite',
        global: {},
        policies: { sites: {}, hosts: {} },
        callerOverrides: 'any',
        proxies: [],
        abortOnDeadline: true,
        warnings: [],
        builtinHosts: true,
        pluginManifests: true,
        callerProxies: 'any',
      });
    });

    it('treats empty and whitespace-only values as unset', () => {
      const cfg = parse({ [CRAWL_ENV.RETRIES]: '', [CRAWL_ENV.PRESET]: '   ', [CRAWL_ENV.USER_AGENT]: ' ' });
      expect(cfg.global).toEqual({});
      expect(cfg.preset).toBe('polite');
      expect(cfg.warnings).toEqual([]);
    });
  });

  describe('EVER_JOBS_CRAWL_PRESET', () => {
    it.each(['polite', 'legacy', 'strict'] as const)('accepts %s', (preset) => {
      expect(parse({ [CRAWL_ENV.PRESET]: preset }).preset).toBe(preset);
    });

    it('is case- and whitespace-insensitive', () => {
      expect(parse({ [CRAWL_ENV.PRESET]: '  Legacy ' }).preset).toBe('legacy');
    });

    it('falls back to polite with a warning on an unknown value', () => {
      const cfg = parse({ [CRAWL_ENV.PRESET]: 'rude' });
      expect(cfg.preset).toBe('polite');
      expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.PRESET)]);
    });
  });

  describe('EVER_JOBS_CRAWL_USER_AGENT / _CONTACT', () => {
    it.each([
      ['default', EVER_JOBS_DEFAULT_USER_AGENT],
      ['everjobs', EVER_JOBS_DEFAULT_USER_AGENT],
      ['DEFAULT', EVER_JOBS_DEFAULT_USER_AGENT],
      ['browser', LEGACY_BROWSER_USER_AGENT],
      ['legacy', LEGACY_BROWSER_USER_AGENT],
      ['MyBot/2.0 (+https://example.test)', 'MyBot/2.0 (+https://example.test)'],
    ])('expands %j', (value, expected) => {
      const cfg = parse({ [CRAWL_ENV.USER_AGENT]: value });
      expect(cfg.global.userAgent).toBe(expected);
      expect(cfg.warnings).toEqual([]);
    });

    it('inserts the contact into the default UA comment', () => {
      const cfg = parse({ [CRAWL_ENV.USER_AGENT]: 'default', [CRAWL_ENV.CONTACT]: 'ops@acme.example' });
      expect(cfg.global.userAgent).toBe(
        'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs; ops@acme.example)',
      );
      expect(cfg.contact).toBe('ops@acme.example');
      expect(cfg.warnings).toEqual([]);
    });

    it('applies the contact to the preset UA when no UA is configured', () => {
      const cfg = parse({ [CRAWL_ENV.CONTACT]: 'ops@acme.example' });
      expect(cfg.global.userAgent).toBe(`${EVER_JOBS_DEFAULT_USER_AGENT.slice(0, -1)}; ops@acme.example)`);
    });

    it('warns (and leaves the UA alone) when the contact cannot be inserted', () => {
      const legacy = parse({ [CRAWL_ENV.PRESET]: 'legacy', [CRAWL_ENV.CONTACT]: 'ops@acme.example' });
      expect(legacy.global.userAgent).toBeUndefined();
      expect(legacy.warnings).toEqual([expect.stringContaining(CRAWL_ENV.CONTACT)]);

      const custom = parse({ [CRAWL_ENV.USER_AGENT]: 'MyBot/2.0', [CRAWL_ENV.CONTACT]: 'ops@acme.example' });
      expect(custom.global.userAgent).toBe('MyBot/2.0');
      expect(custom.warnings).toEqual([expect.stringContaining(CRAWL_ENV.CONTACT)]);
    });

    it('strips header-breaking characters from the UA with a warning', () => {
      const cfg = parse({ [CRAWL_ENV.USER_AGENT]: 'MyBot/2.0\r\nX-Injected: 1' });
      expect(cfg.global.userAgent).toBe('MyBot/2.0X-Injected: 1');
      expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.USER_AGENT)]);
    });

    it('ignores a UA made only of unusable characters', () => {
      const cfg = parse({ [CRAWL_ENV.USER_AGENT]: '\u0001\u0002' });
      expect(cfg.global.userAgent).toBeUndefined();
      expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.USER_AGENT)]);
    });

    it('sanitises the contact (no parentheses, no control characters)', () => {
      const cfg = parse({ [CRAWL_ENV.CONTACT]: ' ops (at) acme\n.example ' });
      expect(cfg.contact).toBe('ops at acme.example');
      expect(cfg.global.userAgent).toContain('; ops at acme.example)');
    });

    it('warns when nothing usable is left of the contact', () => {
      const cfg = parse({ [CRAWL_ENV.CONTACT]: '()' });
      expect(cfg.contact).toBeUndefined();
      expect(cfg.global.userAgent).toBeUndefined();
      expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.CONTACT)]);
    });
  });

  describe('scalar knobs', () => {
    const BOOL_VARS: Array<[string, keyof CrawlPolicy]> = [
      [CRAWL_ENV.STRIP_CLIENT_HINTS, 'stripClientHints'],
      [CRAWL_ENV.ADAPTIVE, 'adaptiveThrottle'],
      [CRAWL_ENV.RETRY_JITTER, 'retryJitter'],
      [CRAWL_ENV.RETRY_ON_NETWORK_ERROR, 'retryOnNetworkError'],
      [CRAWL_ENV.RESPECT_RETRY_AFTER, 'respectRetryAfter'],
      [CRAWL_ENV.BLOCK_PRIVATE_NETWORKS, 'blockPrivateNetworks'],
    ];
    const TRUE_WORDS = ['true', 'TRUE', '1', 'yes', 'on', ' On '];
    const FALSE_WORDS = ['false', 'False', '0', 'no', 'off'];

    describe.each(BOOL_VARS)('%s (bool)', (name, field) => {
      it.each(TRUE_WORDS)('%j → true', (word) => {
        expect(parse({ [name]: word }).global[field]).toBe(true);
      });
      it.each(FALSE_WORDS)('%j → false', (word) => {
        expect(parse({ [name]: word }).global[field]).toBe(false);
      });
      it('ignores an invalid value with a warning', () => {
        const cfg = parse({ [name]: 'maybe' });
        expect(cfg.global[field]).toBeUndefined();
        expect(cfg.warnings).toEqual([expect.stringContaining(name)]);
      });
    });

    const INT_VARS: Array<[string, keyof CrawlPolicy]> = [
      [CRAWL_ENV.MAX_CONCURRENT_PER_HOST, 'maxConcurrentPerHost'],
      [CRAWL_ENV.MIN_INTERVAL_MS, 'minIntervalMs'],
      [CRAWL_ENV.JITTER_MS, 'jitterMs'],
      [CRAWL_ENV.MAX_QUEUE_WAIT_MS, 'maxQueueWaitMs'],
      [CRAWL_ENV.RETRIES, 'retries'],
      [CRAWL_ENV.RETRY_BASE_DELAY_MS, 'retryBaseDelayMs'],
      [CRAWL_ENV.RETRY_MAX_DELAY_MS, 'retryMaxDelayMs'],
      [CRAWL_ENV.MAX_RETRY_AFTER_MS, 'maxRetryAfterMs'],
    ];

    describe.each(INT_VARS)('%s (int >= 0)', (name, field) => {
      it.each([
        ['0', 0],
        ['250', 250],
        [' 1000 ', 1000],
      ])('%j → %d', (raw, expected) => {
        const cfg = parse({ [name]: raw });
        expect(cfg.global[field]).toBe(expected);
        expect(cfg.warnings).toEqual([]);
      });
      it.each(['-1', 'abc', '1e', 'Infinity'])('ignores %j with a warning', (raw) => {
        const cfg = parse({ [name]: raw });
        expect(cfg.global[field]).toBeUndefined();
        expect(cfg.warnings).toEqual([expect.stringContaining(name)]);
      });
      it('rounds a fraction down and clamps a huge value, noting both', () => {
        expect(parse({ [name]: '1.9' }).global[field]).toBe(1);
        const huge = parse({ [name]: '99999999999' });
        expect(huge.global[field]).toBe(2_147_483_647);
        expect(huge.warnings).toEqual([expect.stringContaining('clamped')]);
      });
    });

    const ENUM_VARS: Array<[string, keyof CrawlPolicy, string[]]> = [
      [CRAWL_ENV.USER_AGENT_MODE, 'userAgentMode', ['identify', 'strict', 'plugin']],
      [CRAWL_ENV.PROXY_ROTATION, 'proxyRotation', ['per-request', 'per-scrape', 'per-host', 'off']],
      [CRAWL_ENV.RATE_SCOPE, 'rateLimitScope', ['host', 'domain', 'site']],
      [CRAWL_ENV.RETRY_BACKOFF, 'retryBackoff', ['exponential', 'linear', 'constant']],
      [CRAWL_ENV.RETRY_AFTER_OVER_MAX, 'retryAfterOverMax', ['give-up', 'cap']],
      [CRAWL_ENV.ROBOTS_TXT, 'robotsTxt', ['off', 'crawl-delay', 'respect']],
      [CRAWL_ENV.DISCOVERY, 'discovery', ['auto', 'sitemap', 'listing']],
    ];

    describe.each(ENUM_VARS)('%s (enum)', (name, field, values) => {
      it.each(values)('accepts %s', (value) => {
        expect(parse({ [name]: value }).global[field]).toBe(value);
        expect(parse({ [name]: ` ${value.toUpperCase().replace(/-/g, '_')} ` }).global[field]).toBe(value);
      });
      it('ignores an unknown value with a warning', () => {
        const cfg = parse({ [name]: 'bogus' });
        expect(cfg.global[field]).toBeUndefined();
        expect(cfg.warnings).toEqual([expect.stringContaining(name)]);
      });
    });

    it('EVER_JOBS_CRAWL_FROM sets the From header value', () => {
      expect(parse({ [CRAWL_ENV.FROM]: ' ops@acme.example ' }).global.from).toBe('ops@acme.example');
      const bad = parse({ [CRAWL_ENV.FROM]: '\u0000' });
      expect(bad.global.from).toBeUndefined();
      expect(bad.warnings).toEqual([expect.stringContaining(CRAWL_ENV.FROM)]);
    });

    describe('EVER_JOBS_CRAWL_RETRY_STATUSES', () => {
      it.each([
        ['429,503', [429, 503]],
        [' 429 , 502 ,503 ', [429, 502, 503]],
        ['429 503;504', [429, 503, 504]],
        ['429,429,503', [429, 503]],
        ['none', []],
        ['off', []],
      ])('%j → %j', (raw, expected) => {
        const cfg = parse({ [CRAWL_ENV.RETRY_STATUSES]: raw });
        expect(cfg.global.retryStatuses).toEqual(expected);
        expect(cfg.warnings).toEqual([]);
      });

      it('drops entries outside 100-599 with a warning, keeping the valid ones', () => {
        const cfg = parse({ [CRAWL_ENV.RETRY_STATUSES]: '429,abc,700,99,503' });
        expect(cfg.global.retryStatuses).toEqual([429, 503]);
        expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.RETRY_STATUSES)]);
      });

      it('ignores the variable when nothing valid remains', () => {
        const cfg = parse({ [CRAWL_ENV.RETRY_STATUSES]: 'abc,700' });
        expect(cfg.global.retryStatuses).toBeUndefined();
        expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.RETRY_STATUSES)]);
      });
    });
  });

  describe('pre-1690 RETRY_DEFAULT_* / RETRY_PER_SOURCE', () => {
    it('are not mapped when unset (the configuration.ts defaults do not leak in)', () => {
      const cfg = parse({});
      expect(cfg.global.retries).toBeUndefined();
      expect(cfg.global.retryBaseDelayMs).toBeUndefined();
      expect(cfg.global.retryBackoff).toBeUndefined();
    });

    it('map into env-global when explicitly set', () => {
      const cfg = parse({
        [LEGACY_RETRY_ENV.RETRIES]: '5',
        [LEGACY_RETRY_ENV.DELAY_MS]: '750',
        [LEGACY_RETRY_ENV.BACKOFF]: 'exponential',
      });
      expect(cfg.global).toEqual({ retries: 5, retryBaseDelayMs: 750, retryBackoff: 'exponential' });
      expect(cfg.warnings).toEqual([]);
    });

    it('lose to their EVER_JOBS_CRAWL_* twins', () => {
      const cfg = parse({
        [LEGACY_RETRY_ENV.RETRIES]: '5',
        [CRAWL_ENV.RETRIES]: '1',
        [LEGACY_RETRY_ENV.DELAY_MS]: '750',
        [CRAWL_ENV.RETRY_BASE_DELAY_MS]: '2000',
        [LEGACY_RETRY_ENV.BACKOFF]: 'linear',
        [CRAWL_ENV.RETRY_BACKOFF]: 'constant',
      });
      expect(cfg.global).toEqual({ retries: 1, retryBaseDelayMs: 2000, retryBackoff: 'constant' });
    });

    it('warns on invalid legacy values', () => {
      const cfg = parse({ [LEGACY_RETRY_ENV.RETRIES]: 'lots', [LEGACY_RETRY_ENV.BACKOFF]: 'fibonacci' });
      expect(cfg.global).toEqual({});
      expect(cfg.warnings).toEqual([
        expect.stringContaining(LEGACY_RETRY_ENV.RETRIES),
        expect.stringContaining(LEGACY_RETRY_ENV.BACKOFF),
      ]);
    });

    it('RETRY_PER_SOURCE maps {retries, delayMs, backoff, maxDelayMs} into policies.sites', () => {
      const cfg = parse({
        [LEGACY_RETRY_ENV.PER_SOURCE]: JSON.stringify({
          Softy: { retries: 0, delayMs: 2000, backoff: 'exponential', maxDelayMs: 9000 },
          linkedin: { retries: 1, minIntervalMs: 500 },
        }),
      });
      expect(cfg.policies.sites).toEqual({
        softy: { retries: 0, retryBaseDelayMs: 2000, retryBackoff: 'exponential', retryMaxDelayMs: 9000 },
        linkedin: { retries: 1, minIntervalMs: 500 },
      });
      expect(cfg.warnings).toEqual([]);
    });

    it('explicit EVER_JOBS_CRAWL_POLICIES site entries win over RETRY_PER_SOURCE, field by field', () => {
      const cfg = parse({
        [LEGACY_RETRY_ENV.PER_SOURCE]: JSON.stringify({ softy: { retries: 4, delayMs: 2000 } }),
        [CRAWL_ENV.POLICIES]: JSON.stringify({ sites: { softy: { retries: 0 } } }),
      });
      expect(cfg.policies.sites?.softy).toEqual({ retries: 0, retryBaseDelayMs: 2000 });
    });

    it('warns on malformed RETRY_PER_SOURCE', () => {
      expect(parse({ [LEGACY_RETRY_ENV.PER_SOURCE]: '{not json' }).warnings).toEqual([
        expect.stringContaining(LEGACY_RETRY_ENV.PER_SOURCE),
      ]);
      expect(parse({ [LEGACY_RETRY_ENV.PER_SOURCE]: '[1,2]' }).warnings).toEqual([
        expect.stringContaining(LEGACY_RETRY_ENV.PER_SOURCE),
      ]);
      const badEntry = parse({ [LEGACY_RETRY_ENV.PER_SOURCE]: JSON.stringify({ softy: 3, lever: { retries: -1 } }) });
      expect(badEntry.policies.sites).toEqual({ softy: {}, lever: {} });
      expect(badEntry.warnings).toHaveLength(2);
    });
  });

  describe('EVER_JOBS_CRAWL_POLICIES', () => {
    it('parses sites and hosts, validating every entry', () => {
      const cfg = parse({
        [CRAWL_ENV.POLICIES]: JSON.stringify({
          $comment: 'operator overrides',
          sites: { Softy: { maxConcurrentPerHost: '1', minIntervalMs: 1000, rateLimitScope: 'DOMAIN' } },
          hosts: {
            '*.softy.pro': { maxConcurrentPerHost: 1, _why: 'CTO request' },
            'ACME.Softy.PRO.': { jitterMs: 200 },
            '*': { retryStatuses: '429,503' },
          },
        }),
      });
      expect(cfg.policies).toEqual({
        sites: { softy: { maxConcurrentPerHost: 1, minIntervalMs: 1000, rateLimitScope: 'domain' } },
        hosts: {
          '*.softy.pro': { maxConcurrentPerHost: 1 },
          'acme.softy.pro': { jitterMs: 200 },
          '*': { retryStatuses: [429, 503] },
        },
      });
      expect(cfg.warnings).toEqual([]);
    });

    it('drops invalid entries, fields and patterns with warnings', () => {
      const cfg = parse({
        [CRAWL_ENV.POLICIES]: JSON.stringify({
          sites: { softy: { maxConcurrentPerHost: -2, bogusField: 1, retries: 2 }, '': { retries: 1 } },
          hosts: { 'a*b.example': { retries: 1 }, '.softy.pro': { retries: 1 }, 'ok.example': 'nope' },
          globals: {},
        }),
      });
      expect(cfg.policies.sites).toEqual({ softy: { retries: 2 } });
      expect(cfg.policies.hosts).toEqual({ 'ok.example': {} });
      expect(cfg.warnings).toHaveLength(7);
      expect(cfg.warnings.every((w) => w.startsWith(CRAWL_ENV.POLICIES))).toBe(true);
    });

    it('never lets a key reach Object.prototype', () => {
      const cfg = parse({
        [CRAWL_ENV.POLICIES]: '{"sites":{"__proto__":{"retries":0},"constructor":{"retries":0}}}',
      });
      expect(Object.keys(cfg.policies.sites ?? {})).toEqual([]);
      expect(({} as Record<string, unknown>).retries).toBeUndefined();
      // "__proto__" starts with "_" and is skipped as a comment key; "constructor" is refused.
      expect(cfg.warnings).toEqual([expect.stringContaining('"constructor"')]);
    });

    it.each(['{bad json', '[]', '42', '"sites"'])('warns on a malformed document %j', (raw) => {
      const cfg = parse({ [CRAWL_ENV.POLICIES]: raw });
      expect(cfg.policies).toEqual({ sites: {}, hosts: {} });
      expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.POLICIES)]);
    });

    it('warns when a section is not an object', () => {
      const cfg = parse({ [CRAWL_ENV.POLICIES]: JSON.stringify({ sites: ['softy'], hosts: null }) });
      expect(cfg.policies).toEqual({ sites: {}, hosts: {} });
      expect(cfg.warnings).toEqual([expect.stringContaining('"sites" must be an object')]);
    });
  });

  describe('EVER_JOBS_CRAWL_POLICY_FILE', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'crawl-policy-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('reads the file (BOM tolerated); the env JSON wins per field', () => {
      const file = join(dir, 'policy.json');
      writeFileSync(
        file,
        '﻿' +
          JSON.stringify({
            sites: { softy: { maxConcurrentPerHost: 1, minIntervalMs: 1000 }, lever: { retries: 0 } },
            hosts: { '*.softy.pro': { jitterMs: 100 } },
          }),
      );
      const cfg = parse({
        [CRAWL_ENV.POLICY_FILE]: file,
        [CRAWL_ENV.POLICIES]: JSON.stringify({ sites: { softy: { minIntervalMs: 2000 } } }),
      });
      expect(cfg.policies).toEqual({
        sites: { softy: { maxConcurrentPerHost: 1, minIntervalMs: 2000 }, lever: { retries: 0 } },
        hosts: { '*.softy.pro': { jitterMs: 100 } },
      });
      expect(cfg.warnings).toEqual([]);
    });

    it('warns on a missing or unparseable file', () => {
      const missing = parse({ [CRAWL_ENV.POLICY_FILE]: join(dir, 'nope.json') });
      expect(missing.warnings).toEqual([expect.stringContaining('cannot read')]);

      const file = join(dir, 'bad.json');
      writeFileSync(file, '{ nope');
      const bad = parse({ [CRAWL_ENV.POLICY_FILE]: file });
      expect(bad.warnings).toEqual([expect.stringContaining('invalid JSON')]);
      expect(bad.policies).toEqual({ sites: {}, hosts: {} });
    });
  });

  describe('EVER_JOBS_CRAWL_CALLER_OVERRIDES', () => {
    it.each(['any', 'stricter', 'none'] as const)('accepts %s', (mode) => {
      expect(parse({ [CRAWL_ENV.CALLER_OVERRIDES]: mode.toUpperCase() }).callerOverrides).toBe(mode);
    });
    it('keeps "any" with a warning on an unknown value', () => {
      const cfg = parse({ [CRAWL_ENV.CALLER_OVERRIDES]: 'some' });
      expect(cfg.callerOverrides).toBe('any');
      expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.CALLER_OVERRIDES)]);
    });
  });

  describe('EVER_JOBS_CRAWL_ABORT_ON_DEADLINE', () => {
    it('is true by default and can be turned off', () => {
      expect(parse({}).abortOnDeadline).toBe(true);
      expect(parse({ [CRAWL_ENV.ABORT_ON_DEADLINE]: 'off' }).abortOnDeadline).toBe(false);
    });
    it('keeps true with a warning on an invalid value', () => {
      const cfg = parse({ [CRAWL_ENV.ABORT_ON_DEADLINE]: 'sometimes' });
      expect(cfg.abortOnDeadline).toBe(true);
      expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.ABORT_ON_DEADLINE)]);
    });
  });

  describe('EVER_JOBS_CRAWL_PROXIES / DEFAULT_PROXIES', () => {
    it('parses a comma/space list', () => {
      expect(parse({ [CRAWL_ENV.PROXIES]: 'http://a:1, socks5://b:2 \n http://c:3' }).proxies).toEqual([
        'http://a:1',
        'socks5://b:2',
        'http://c:3',
      ]);
    });

    it('parses a JSON array', () => {
      expect(parse({ [CRAWL_ENV.PROXIES]: '["http://a:1","localhost"]' }).proxies).toEqual(['http://a:1', 'localhost']);
    });

    it('falls back to DEFAULT_PROXIES', () => {
      expect(parse({ [CRAWL_ENV.LEGACY_PROXIES]: 'http://legacy:1' }).proxies).toEqual(['http://legacy:1']);
      expect(
        parse({ [CRAWL_ENV.PROXIES]: 'http://new:1', [CRAWL_ENV.LEGACY_PROXIES]: 'http://legacy:1' }).proxies,
      ).toEqual(['http://new:1']);
    });

    it('"none" disables proxies without falling back', () => {
      const cfg = parse({ [CRAWL_ENV.PROXIES]: 'none', [CRAWL_ENV.LEGACY_PROXIES]: 'http://legacy:1' });
      expect(cfg.proxies).toEqual([]);
      expect(cfg.warnings).toEqual([]);
    });

    it('warns and falls back when the list has no usable entry', () => {
      const cfg = parse({ [CRAWL_ENV.PROXIES]: ',,,', [CRAWL_ENV.LEGACY_PROXIES]: 'http://legacy:1' });
      expect(cfg.proxies).toEqual(['http://legacy:1']);
      expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.PROXIES)]);
    });

    it('never echoes proxy values (they may carry credentials) in warnings', () => {
      const cfg = parse({ [CRAWL_ENV.PROXIES]: ',', [CRAWL_ENV.LEGACY_PROXIES]: 'http://user:secret@p:1' });
      expect(cfg.warnings.join('\n')).not.toContain('secret');
    });

    it('legacy: DEFAULT_PROXIES is not used (pre-1690 never used it), with a warning; EVER_JOBS_CRAWL_PROXIES still is', () => {
      const legacy = parse({ [CRAWL_ENV.PRESET]: 'legacy', [CRAWL_ENV.LEGACY_PROXIES]: 'http://user:secret@legacy:1' });
      expect(legacy.proxies).toEqual([]);
      expect(legacy.warnings).toEqual([expect.stringContaining(CRAWL_EXTRA_ENV.DEFAULT_PROXIES_FALLBACK)]);
      expect(legacy.warnings.join('\n')).not.toContain('secret');
      expect(parse({ [CRAWL_ENV.PRESET]: 'legacy', [CRAWL_ENV.PROXIES]: 'http://new:1' }).proxies).toEqual(['http://new:1']);
    });

    it('EVER_JOBS_CRAWL_DEFAULT_PROXIES_FALLBACK switches the fallback on (legacy) or off (polite)', () => {
      expect(
        parse({
          [CRAWL_ENV.PRESET]: 'legacy',
          [CRAWL_ENV.LEGACY_PROXIES]: 'http://legacy:1',
          [CRAWL_EXTRA_ENV.DEFAULT_PROXIES_FALLBACK]: 'true',
        }).proxies,
      ).toEqual(['http://legacy:1']);
      expect(
        parse({ [CRAWL_ENV.LEGACY_PROXIES]: 'http://legacy:1', [CRAWL_EXTRA_ENV.DEFAULT_PROXIES_FALLBACK]: 'off' }).proxies,
      ).toEqual([]);
    });

    it('parseCrawlProxyList handles undefined, blanks and non-string JSON items', () => {
      expect(parseCrawlProxyList(undefined)).toEqual([]);
      expect(parseCrawlProxyList('   ')).toEqual([]);
      expect(parseCrawlProxyList('["a", 1, null, " b "]')).toEqual(['a', 'b']);
      expect(parseCrawlProxyList('[not json')).toEqual(['[not', 'json']);
    });
  });

  describe('post-contract switches (CRAWL_EXTRA_ENV)', () => {
    it('builtin hosts and plugin manifests default on, and off under legacy', () => {
      expect(parse({})).toMatchObject({ builtinHosts: true, pluginManifests: true });
      expect(parse({ [CRAWL_ENV.PRESET]: 'legacy' })).toMatchObject({ builtinHosts: false, pluginManifests: false });
      expect(parse({ [CRAWL_ENV.PRESET]: 'strict' })).toMatchObject({ builtinHosts: true, pluginManifests: true });
    });

    it('each switch overrides the preset default; an invalid value keeps it, with a warning', () => {
      const cfg = parse({
        [CRAWL_ENV.PRESET]: 'legacy',
        [CRAWL_EXTRA_ENV.BUILTIN_HOSTS]: 'yes',
        [CRAWL_EXTRA_ENV.PLUGIN_MANIFESTS]: 'maybe',
      });
      expect(cfg.builtinHosts).toBe(true);
      expect(cfg.pluginManifests).toBe(false);
      expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_EXTRA_ENV.PLUGIN_MANIFESTS)]);
    });

    it('caller proxies: "any" only when caller overrides are "any", unless set', () => {
      expect(parse({}).callerProxies).toBe('any');
      expect(parse({ [CRAWL_ENV.CALLER_OVERRIDES]: 'stricter' }).callerProxies).toBe('none');
      expect(parse({ [CRAWL_ENV.CALLER_OVERRIDES]: 'none' }).callerProxies).toBe('none');
      expect(parse({ [CRAWL_EXTRA_ENV.CALLER_PROXIES]: 'none' }).callerProxies).toBe('none');
      expect(parse({ [CRAWL_ENV.CALLER_OVERRIDES]: 'none', [CRAWL_EXTRA_ENV.CALLER_PROXIES]: 'any' }).callerProxies).toBe('any');
      const bad = parse({ [CRAWL_EXTRA_ENV.CALLER_PROXIES]: 'some' });
      expect(bad.callerProxies).toBe('any');
      expect(bad.warnings).toEqual([expect.stringContaining(CRAWL_EXTRA_ENV.CALLER_PROXIES)]);
    });

    it('the accessors fall back by preset / caller overrides for a hand-built config', () => {
      const bare = { preset: 'legacy', global: {}, policies: {}, callerOverrides: 'stricter', proxies: [], abortOnDeadline: true, warnings: [] } as const;
      expect(crawlBuiltinHostsEnabled(bare as never)).toBe(false);
      expect(crawlPluginManifestsEnabled(bare as never)).toBe(false);
      expect(crawlCallerProxiesAllowed(bare as never)).toBe(false);
      expect(crawlBuiltinHostsEnabled({ ...bare, preset: 'polite' } as never)).toBe(true);
      expect(crawlCallerProxiesAllowed({ ...bare, callerOverrides: 'any' } as never)).toBe(true);
    });
  });

  it('covers every CRAWL_ENV variable (a new variable must be added here)', () => {
    const samples: Record<keyof typeof CRAWL_ENV, string> = {
      PRESET: 'strict',
      USER_AGENT: 'MyBot/1.0',
      USER_AGENT_MODE: 'plugin',
      CONTACT: 'ops@acme.example',
      FROM: 'ops@acme.example',
      STRIP_CLIENT_HINTS: 'false',
      PROXY_ROTATION: 'off',
      PROXIES: 'http://p:1',
      LEGACY_PROXIES: 'http://q:1',
      RATE_SCOPE: 'site',
      MAX_CONCURRENT_PER_HOST: '2',
      MIN_INTERVAL_MS: '500',
      JITTER_MS: '50',
      MAX_QUEUE_WAIT_MS: '10000',
      ADAPTIVE: 'false',
      RETRIES: '1',
      RETRY_STATUSES: '429',
      RETRY_BACKOFF: 'linear',
      RETRY_BASE_DELAY_MS: '10',
      RETRY_MAX_DELAY_MS: '20',
      RETRY_JITTER: 'false',
      RETRY_ON_NETWORK_ERROR: 'true',
      RESPECT_RETRY_AFTER: 'false',
      MAX_RETRY_AFTER_MS: '5',
      RETRY_AFTER_OVER_MAX: 'cap',
      ROBOTS_TXT: 'respect',
      BLOCK_PRIVATE_NETWORKS: 'false',
      DISCOVERY: 'sitemap',
      POLICIES: '{"sites":{"softy":{"retries":0}}}',
      POLICY_FILE: '',
      CALLER_OVERRIDES: 'none',
      ABORT_ON_DEADLINE: 'false',
    };
    const env: Record<string, string> = {};
    for (const key of Object.keys(CRAWL_ENV) as (keyof typeof CRAWL_ENV)[]) env[CRAWL_ENV[key]] = samples[key];

    const cfg = parse(env);
    expect(cfg.warnings).toEqual([expect.stringContaining(CRAWL_ENV.CONTACT)]); // custom UA takes no contact
    expect(cfg.preset).toBe('strict');
    expect(cfg.callerOverrides).toBe('none');
    expect(cfg.abortOnDeadline).toBe(false);
    expect(cfg.proxies).toEqual(['http://p:1']);
    expect(cfg.policies.sites).toEqual({ softy: { retries: 0 } });
    expect(cfg.global).toEqual({
      userAgent: 'MyBot/1.0',
      userAgentMode: 'plugin',
      from: 'ops@acme.example',
      stripClientHints: false,
      proxyRotation: 'off',
      rateLimitScope: 'site',
      maxConcurrentPerHost: 2,
      minIntervalMs: 500,
      jitterMs: 50,
      maxQueueWaitMs: 10000,
      adaptiveThrottle: false,
      retries: 1,
      retryStatuses: [429],
      retryBackoff: 'linear',
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
      retryJitter: false,
      retryOnNetworkError: true,
      respectRetryAfter: false,
      maxRetryAfterMs: 5,
      retryAfterOverMax: 'cap',
      robotsTxt: 'respect',
      blockPrivateNetworks: false,
      discovery: 'sitemap',
    });
    // every policy field is settable from the environment
    expect(Object.keys(cfg.global).sort()).toEqual(Object.keys(CRAWL_PRESETS.polite).concat('from').sort());
  });

  describe('expandUserAgent', () => {
    it.each([
      [undefined, undefined, EVER_JOBS_DEFAULT_USER_AGENT],
      ['', undefined, EVER_JOBS_DEFAULT_USER_AGENT],
      ['  ', 'ops@x', `${EVER_JOBS_DEFAULT_USER_AGENT.slice(0, -1)}; ops@x)`],
      ['Default', 'ops@x', `${EVER_JOBS_DEFAULT_USER_AGENT.slice(0, -1)}; ops@x)`],
      [EVER_JOBS_DEFAULT_USER_AGENT, 'ops@x', `${EVER_JOBS_DEFAULT_USER_AGENT.slice(0, -1)}; ops@x)`],
      ['Browser', 'ops@x', LEGACY_BROWSER_USER_AGENT],
      ['constructor', undefined, 'constructor'],
      ['Custom/1.0', 'ops@x', 'Custom/1.0'],
      [' Custom/1.0\n', undefined, 'Custom/1.0'],
    ])('(%j, %j) → %j', (value, contact, expected) => {
      expect(expandUserAgent(value, contact)).toBe(expected);
    });

    it('is idempotent', () => {
      const once = expandUserAgent('default', 'ops@x');
      expect(expandUserAgent(once, 'ops@x')).toBe(once);
    });
  });

  describe('process.env cache', () => {
    const touched = [CRAWL_ENV.RETRIES, CRAWL_ENV.PRESET, LEGACY_RETRY_ENV.RETRIES];
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const name of touched) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
      resetCrawlPolicyEnvCache();
    });
    afterEach(() => {
      for (const name of touched) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      resetCrawlPolicyEnvCache();
      jest.restoreAllMocks();
    });

    it('parses process.env once and returns the same object', () => {
      const a = readCrawlPolicyEnv();
      expect(readCrawlPolicyEnv()).toBe(a);
      expect(readCrawlPolicyEnv(process.env)).toBe(a);
    });

    it('keeps the parse until reset; a runtime env change needs resetCrawlPolicyEnvCache()', () => {
      const a = readCrawlPolicyEnv();
      process.env[CRAWL_ENV.RETRIES] = '0';
      expect(readCrawlPolicyEnv()).toBe(a);

      resetCrawlPolicyEnvCache();
      const b = readCrawlPolicyEnv();
      expect(b).not.toBe(a);
      expect(b.global.retries).toBe(0);

      delete process.env[CRAWL_ENV.RETRIES];
      process.env[LEGACY_RETRY_ENV.RETRIES] = '6';
      resetCrawlPolicyEnvCache();
      expect(readCrawlPolicyEnv().global.retries).toBe(6);
    });

    it('CRAWL_POLICY_ENV_VARS lists every variable read', () => {
      expect([...CRAWL_POLICY_ENV_VARS].sort()).toEqual(
        [...Object.values(CRAWL_ENV), ...Object.values(CRAWL_EXTRA_ENV), ...Object.values(LEGACY_RETRY_ENV)].sort(),
      );
    });

    it('resetCrawlPolicyEnvCache forces a fresh parse', () => {
      const a = readCrawlPolicyEnv();
      resetCrawlPolicyEnvCache();
      const b = readCrawlPolicyEnv();
      expect(b).not.toBe(a);
      expect(b).toEqual(a);
    });

    it('logs the warnings of a process.env parse once, through the Nest Logger', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      process.env[CRAWL_ENV.PRESET] = 'rude';
      readCrawlPolicyEnv();
      readCrawlPolicyEnv();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(CRAWL_ENV.PRESET);
    });

    it('an explicit env object is parsed without touching the cache or the logger', () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const a = readCrawlPolicyEnv();
      const explicit = readCrawlPolicyEnv({ [CRAWL_ENV.PRESET]: 'rude' });
      expect(explicit.warnings).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      expect(readCrawlPolicyEnv()).toBe(a);
    });
  });
});
