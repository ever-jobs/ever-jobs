import { Logger } from '@nestjs/common';

import { readSoftyConfig, readSoftyLegacy, resetSoftyConfigWarnings } from '../src/softy.config';
import {
  SOFTY_DETAIL_ATTEMPT_SLACK,
  SOFTY_DETAIL_CACHE_TTL_MS,
  SOFTY_ENV,
  SOFTY_LEGACY_DETAIL_CACHE_TTL_MS,
  SOFTY_LEGACY_INDEX_PATH,
  SOFTY_LEGACY_MAX_CONSECUTIVE_DETAIL_FAILURES,
  SOFTY_LEGACY_TOKENS,
  SOFTY_LISTING_DETAIL_CACHE_TTL_MS,
  SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES,
  SOFTY_MIN_INTERVAL_FLOOR_MS,
  SOFTY_OFFERS_PATH,
  SOFTY_SITEMAP_CACHE_MAX,
  SOFTY_SITEMAP_CACHE_TTL_MS,
  SOFTY_SITEMAP_FALLBACK,
  SOFTY_SITEMAP_FALLBACKS,
  SOFTY_UNKNOWN_TENANT_CACHE_MAX,
  SOFTY_UNKNOWN_TENANT_TTL_MAX_MS,
  SOFTY_UNKNOWN_TENANT_TTL_MS,
} from '../src/softy.constants';
import * as barrel from '../src';

/**
 * Spec 1715 T01 — the Softy knobs added by the audit hardening: constants, env
 * parsing (valid / invalid / clamp), `SOFTY_LEGACY` tokens, and the derived values.
 */
describe('Softy configuration (Spec 1715)', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    resetSoftyConfigWarnings();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const warnings = (): string[] => warn.mock.calls.map((c) => String(c[0]));

  it('exposes the contract constants (spec §7.1)', () => {
    expect(SOFTY_MIN_INTERVAL_FLOOR_MS).toBe(1000);
    expect(SOFTY_SITEMAP_FALLBACK).toBe('empty');
    expect(SOFTY_SITEMAP_FALLBACKS).toEqual(['empty', 'missing', 'any-error']);
    expect(SOFTY_UNKNOWN_TENANT_TTL_MS).toBe(3_600_000);
    expect(SOFTY_UNKNOWN_TENANT_TTL_MAX_MS).toBe(86_400_000);
    expect(SOFTY_UNKNOWN_TENANT_CACHE_MAX).toBe(1000);
    expect(SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES).toBe(1);
    expect(SOFTY_LEGACY_MAX_CONSECUTIVE_DETAIL_FAILURES).toBe(3);
    expect(SOFTY_DETAIL_ATTEMPT_SLACK).toBe(5);
    expect(SOFTY_SITEMAP_CACHE_TTL_MS).toBe(600_000);
    expect(SOFTY_SITEMAP_CACHE_MAX).toBe(200);
    expect(SOFTY_DETAIL_CACHE_TTL_MS).toBe(0);
    expect(SOFTY_LISTING_DETAIL_CACHE_TTL_MS).toBe(21_600_000);
    expect(SOFTY_LEGACY_DETAIL_CACHE_TTL_MS).toBe(21_600_000);
    expect(SOFTY_LEGACY_INDEX_PATH).toBe('/offers');
    expect(SOFTY_OFFERS_PATH).toBe('/offres');
    expect([...SOFTY_LEGACY_TOKENS]).toEqual([
      'offset-budget',
      'duplicate-ids',
      'board-over-sitemap',
      'offres',
      'block-as-missing',
      '503-as-failure',
      'listing-failure-details',
      'no-interval-floor',
      'caller-listing',
      'nested-skip',
      'legacy-detail-url',
    ]);
    expect(SOFTY_ENV).toMatchObject({
      SITEMAP_FALLBACK: 'SOFTY_SITEMAP_FALLBACK',
      UNKNOWN_TENANT_TTL_MS: 'SOFTY_UNKNOWN_TENANT_TTL_MS',
      DETAIL_ATTEMPT_SLACK: 'SOFTY_DETAIL_ATTEMPT_SLACK',
      SITEMAP_CACHE_TTL_MS: 'SOFTY_SITEMAP_CACHE_TTL_MS',
      LEGACY: 'SOFTY_LEGACY',
    });
  });

  it('exports the new helpers from the package barrel', () => {
    expect(barrel.readSoftyLegacy).toBe(readSoftyLegacy);
    expect(barrel.softySitemapBodyKind).toBeDefined();
    expect(barrel.softyOfferUrlFrom).toBeDefined();
    expect(barrel.SOFTY_LEGACY_TOKENS).toBe(SOFTY_LEGACY_TOKENS);
  });

  describe('SOFTY_SITEMAP_FALLBACK', () => {
    it.each([
      ['empty', 'empty'],
      ['missing', 'missing'],
      ['any-error', 'any-error'],
      [' Any_Error ', 'any-error'],
      ['MISSING', 'missing'],
    ])('%j → %j', (raw, value) => {
      expect(readSoftyConfig({ SOFTY_SITEMAP_FALLBACK: raw }).sitemapFallback).toBe(value);
    });

    it('an invalid value is warned once and ignored', () => {
      expect(readSoftyConfig({ SOFTY_SITEMAP_FALLBACK: 'always' }).sitemapFallback).toBe('empty');
      expect(readSoftyConfig({ SOFTY_SITEMAP_FALLBACK: 'always' }).sitemapFallback).toBe('empty');
      expect(warnings().filter((w) => w.includes('SOFTY_SITEMAP_FALLBACK'))).toHaveLength(1);
    });
  });

  describe('SOFTY_UNKNOWN_TENANT_TTL_MS', () => {
    it('accepts 0..86,400,000', () => {
      expect(readSoftyConfig({ SOFTY_UNKNOWN_TENANT_TTL_MS: '0' }).unknownTenantTtlMs).toBe(0);
      expect(readSoftyConfig({ SOFTY_UNKNOWN_TENANT_TTL_MS: '60000' }).unknownTenantTtlMs).toBe(60000);
      expect(readSoftyConfig({ SOFTY_UNKNOWN_TENANT_TTL_MS: '86400000' }).unknownTenantTtlMs).toBe(86_400_000);
      expect(warnings()).toEqual([]);
    });

    it('clamps a larger value to 24 h with a one-time warning', () => {
      expect(readSoftyConfig({ SOFTY_UNKNOWN_TENANT_TTL_MS: '90000000' }).unknownTenantTtlMs).toBe(86_400_000);
      expect(readSoftyConfig({ SOFTY_UNKNOWN_TENANT_TTL_MS: '90000000' }).unknownTenantTtlMs).toBe(86_400_000);
      expect(warnings().filter((w) => w.includes('SOFTY_UNKNOWN_TENANT_TTL_MS'))).toHaveLength(1);
    });

    it('ignores an invalid value', () => {
      expect(readSoftyConfig({ SOFTY_UNKNOWN_TENANT_TTL_MS: '-5' }).unknownTenantTtlMs).toBe(3_600_000);
      expect(readSoftyConfig({ SOFTY_UNKNOWN_TENANT_TTL_MS: '1h' }).unknownTenantTtlMs).toBe(3_600_000);
    });
  });

  describe('SOFTY_DETAIL_ATTEMPT_SLACK / SOFTY_SITEMAP_CACHE_TTL_MS / SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES / SOFTY_MAX_LIST_PAGES', () => {
    it('reads valid values', () => {
      const cfg = readSoftyConfig({
        SOFTY_DETAIL_ATTEMPT_SLACK: '0',
        SOFTY_SITEMAP_CACHE_TTL_MS: '30000',
        SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES: '3',
        SOFTY_MAX_LIST_PAGES: '0',
      });
      expect(cfg).toMatchObject({
        detailAttemptSlack: 0,
        sitemapCacheTtlMs: 30000,
        maxConsecutiveDetailFailures: 3,
        maxListPages: 0,
      });
    });

    it('falls back to the defaults on invalid values', () => {
      const cfg = readSoftyConfig({
        SOFTY_DETAIL_ATTEMPT_SLACK: 'x',
        SOFTY_SITEMAP_CACHE_TTL_MS: '-1',
        SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES: '1.5',
        SOFTY_MAX_LIST_PAGES: '-3',
      });
      expect(cfg).toMatchObject({
        detailAttemptSlack: 5,
        sitemapCacheTtlMs: 600_000,
        maxConsecutiveDetailFailures: 1,
        maxListPages: 50,
      });
      expect(warnings()).toHaveLength(4);
    });
  });

  describe('SOFTY_DETAIL_CACHE_TTL_MS (FR-13)', () => {
    it('unset: sitemap entries never expire, listing entries keep 6 h', () => {
      expect(readSoftyConfig({})).toMatchObject({ detailCacheTtlMs: 0, listingDetailCacheTtlMs: 21_600_000 });
    });

    it('set: every entry uses it, as before Spec 1715', () => {
      expect(readSoftyConfig({ SOFTY_DETAIL_CACHE_TTL_MS: '21600000' })).toMatchObject({
        detailCacheTtlMs: 21_600_000,
        listingDetailCacheTtlMs: 21_600_000,
      });
      expect(readSoftyConfig({ SOFTY_DETAIL_CACHE_TTL_MS: '0' })).toMatchObject({
        detailCacheTtlMs: 0,
        listingDetailCacheTtlMs: 0,
      });
    });

    it('invalid: the unset behaviour, with a warning', () => {
      expect(readSoftyConfig({ SOFTY_DETAIL_CACHE_TTL_MS: 'soon' })).toMatchObject({
        detailCacheTtlMs: 0,
        listingDetailCacheTtlMs: 21_600_000,
      });
      expect(warnings()).toHaveLength(1);
    });
  });

  describe('SOFTY_LEGACY (FR-17)', () => {
    it('is empty by default', () => {
      expect(readSoftyLegacy({}).size).toBe(0);
      expect(readSoftyLegacy({ SOFTY_LEGACY: '  ' }).size).toBe(0);
    });

    it('`all` is every token', () => {
      expect([...readSoftyLegacy({ SOFTY_LEGACY: 'all' })].sort()).toEqual([...SOFTY_LEGACY_TOKENS].sort());
      expect(readSoftyLegacy({ SOFTY_LEGACY: 'ALL' }).size).toBe(SOFTY_LEGACY_TOKENS.length);
    });

    it('reads a mixed list; an unknown token is warned once and ignored', () => {
      const env = { SOFTY_LEGACY: ' Offres, 503-as-failure  bogus-token,offset-budget ' };
      expect([...readSoftyLegacy(env)]).toEqual(['offres', '503-as-failure', 'offset-budget']);
      readSoftyLegacy(env);
      const unknown = warnings().filter((w) => w.includes('bogus-token'));
      expect(unknown).toHaveLength(1);
      expect(unknown[0]).toContain('SOFTY_LEGACY');
    });

    it('knows the round-2 tokens: read one by one, part of `all`, named by the unknown-token warning', () => {
      const round2 = ['caller-listing', 'nested-skip', 'legacy-detail-url'];
      expect([...readSoftyLegacy({ SOFTY_LEGACY: 'Caller-Listing,nested-skip legacy-detail-url' })]).toEqual(round2);
      const all = readSoftyLegacy({ SOFTY_LEGACY: 'all' });
      for (const token of round2) expect(all.has(token as never)).toBe(true);
      readSoftyLegacy({ SOFTY_LEGACY: 'no-such-token-r2' });
      const unknown = warnings().filter((w) => w.includes('no-such-token-r2'));
      expect(unknown).toHaveLength(1);
      for (const token of round2) expect(unknown[0]).toContain(token);
      expect(warnings().filter((w) => round2.some((t) => w.includes(`token "${t}"`)))).toEqual([]);
    });

    it('no-interval-floor drops the client floor (derived minIntervalFloorMs)', () => {
      expect(readSoftyConfig({}).minIntervalFloorMs).toBe(1000);
      expect(readSoftyConfig({ SOFTY_LEGACY: 'no-interval-floor' }).minIntervalFloorMs).toBe(0);
      expect(readSoftyConfig({ SOFTY_LEGACY: 'all' }).minIntervalFloorMs).toBe(0);
    });
  });

  it('the documented rollback set restores the pre-1715 plugin values (plan §7)', () => {
    const cfg = readSoftyConfig({
      SOFTY_SITEMAP_FALLBACK: 'any-error',
      SOFTY_LEGACY: 'all',
      SOFTY_MAX_CONSECUTIVE_DETAIL_FAILURES: '3',
      SOFTY_DETAIL_ATTEMPT_SLACK: '100',
      SOFTY_UNKNOWN_TENANT_TTL_MS: '0',
      SOFTY_SITEMAP_CACHE_TTL_MS: '0',
      SOFTY_DETAIL_CACHE_TTL_MS: '21600000',
    });
    expect(cfg).toMatchObject({
      sitemapFallback: 'any-error',
      maxConsecutiveDetailFailures: SOFTY_LEGACY_MAX_CONSECUTIVE_DETAIL_FAILURES,
      detailAttemptSlack: 100,
      unknownTenantTtlMs: 0,
      sitemapCacheTtlMs: 0,
      detailCacheTtlMs: SOFTY_LEGACY_DETAIL_CACHE_TTL_MS,
      listingDetailCacheTtlMs: SOFTY_LEGACY_DETAIL_CACHE_TTL_MS,
      minIntervalFloorMs: 0,
    });
    expect(cfg.legacy.size).toBe(SOFTY_LEGACY_TOKENS.length);
  });
});
