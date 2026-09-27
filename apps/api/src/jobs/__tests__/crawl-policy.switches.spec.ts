import { Logger } from '@nestjs/common';
import { CRAWL_ENV, resetCrawlPolicyEnvCache } from '@ever-jobs/common';
import {
  DEFAULT_LIVENESS_TRUST_LISTED_MAX_AGE_MS,
  LIVENESS_TRUST_FRESH_FETCH_ENV,
  LIVENESS_TRUST_LISTED_MAX_AGE_ENV,
  SEARCH_STOP_ON_503_ENV,
  crawlPresetIsLegacy,
  livenessTrustFreshFetch,
  livenessTrustListedMaxAgeMs,
  resetSwitchWarnings,
  searchStopOn503,
} from '../crawl-policy.mapping';

/**
 * The Spec 1714 / 1715 API switches (`EVER_JOBS_SEARCH_STOP_ON_503`,
 * `EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH`, `EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS`;
 * `EVER_JOBS_BREAKER_COUNT_REFUSALS` is covered in circuit-breaker.refusals.spec.ts):
 *
 * - Spec 1715 review F7: unset, each takes its PRE-1714 value under
 *   `EVER_JOBS_CRAWL_PRESET=legacy`, like the crawl switches of `CRAWL_EXTRA_ENV`;
 *   an explicit value always wins.
 * - Spec 1715 review F8: an unrecognised value keeps the default and is logged
 *   once per variable and value, naming the variable and the value used.
 */
describe('Spec 1714 API switches — legacy preset defaults and invalid values', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    resetSwitchWarnings();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    resetSwitchWarnings();
  });

  const legacy = { [CRAWL_ENV.PRESET]: 'legacy' };

  describe('crawlPresetIsLegacy', () => {
    it('agrees with the crawl layer on what "legacy" is', () => {
      expect(crawlPresetIsLegacy({})).toBe(false);
      expect(crawlPresetIsLegacy({ [CRAWL_ENV.PRESET]: 'legacy' })).toBe(true);
      expect(crawlPresetIsLegacy({ [CRAWL_ENV.PRESET]: ' Legacy ' })).toBe(true);
      expect(crawlPresetIsLegacy({ [CRAWL_ENV.PRESET]: 'polite' })).toBe(false);
      expect(crawlPresetIsLegacy({ [CRAWL_ENV.PRESET]: 'strict' })).toBe(false);
      // The crawl layer replaces an invalid preset with `polite`.
      expect(crawlPresetIsLegacy({ [CRAWL_ENV.PRESET]: 'old' })).toBe(false);
    });

    it('reads process.env through the cached crawl env parse', () => {
      const saved = process.env[CRAWL_ENV.PRESET];
      try {
        process.env[CRAWL_ENV.PRESET] = 'legacy';
        resetCrawlPolicyEnvCache();
        expect(crawlPresetIsLegacy()).toBe(true);
        expect(searchStopOn503()).toBe(false);
        expect(livenessTrustFreshFetch()).toBe(false);
        expect(livenessTrustListedMaxAgeMs()).toBe(0);
      } finally {
        if (saved === undefined) delete process.env[CRAWL_ENV.PRESET];
        else process.env[CRAWL_ENV.PRESET] = saved;
        resetCrawlPolicyEnvCache();
      }
    });
  });

  describe.each([
    ['EVER_JOBS_SEARCH_STOP_ON_503', SEARCH_STOP_ON_503_ENV, searchStopOn503],
    ['EVER_JOBS_LIVENESS_TRUST_FRESH_FETCH', LIVENESS_TRUST_FRESH_FETCH_ENV, livenessTrustFreshFetch],
  ] as const)('%s', (label, name, read) => {
    it('is the variable name the docs use', () => {
      expect(name).toBe(label);
    });

    it('defaults to true, and to false (pre-1714) under the legacy preset', () => {
      expect(read({})).toBe(true);
      expect(read({ [name]: '' })).toBe(true);
      expect(read({ [name]: '  ' })).toBe(true);
      expect(read({ ...legacy })).toBe(false);
      expect(read({ ...legacy, [name]: '' })).toBe(false);
      expect(read({ [CRAWL_ENV.PRESET]: 'strict' })).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it('an explicit value wins over the legacy preset', () => {
      expect(read({ ...legacy, [name]: 'true' })).toBe(true);
      expect(read({ ...legacy, [name]: 'ON' })).toBe(true);
      expect(read({ [name]: 'false' })).toBe(false);
      expect(read({ [name]: 'Off' })).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('an invalid value keeps the default and is logged once per value, naming the variable and the value used', () => {
      expect(read({ [name]: 'disabled' })).toBe(true);
      expect(read({ [name]: 'disabled' })).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(
        `${name}="disabled" is not a boolean (true/false/1/0/yes/no/on/off); using true`,
      );

      // Another value is reported too, and under the legacy preset the value used is false.
      expect(read({ ...legacy, [name]: 'nope' })).toBe(false);
      expect(read({ ...legacy, [name]: 'nope' })).toBe(false);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]![0]).toBe(`${name}="nope" is not a boolean (true/false/1/0/yes/no/on/off); using false`);
    });
  });

  describe('EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS', () => {
    const name = LIVENESS_TRUST_LISTED_MAX_AGE_ENV;

    it('is the variable name the docs use', () => {
      expect(name).toBe('EVER_JOBS_LIVENESS_TRUST_LISTED_MAX_AGE_MS');
    });

    it('defaults to 600000, and to 0 (off, pre-fix) under the legacy preset', () => {
      expect(DEFAULT_LIVENESS_TRUST_LISTED_MAX_AGE_MS).toBe(600_000);
      expect(livenessTrustListedMaxAgeMs({})).toBe(600_000);
      expect(livenessTrustListedMaxAgeMs({ [name]: ' ' })).toBe(600_000);
      expect(livenessTrustListedMaxAgeMs({ ...legacy })).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    });

    it('reads a non-negative integer; an explicit value wins over the legacy preset', () => {
      expect(livenessTrustListedMaxAgeMs({ [name]: '0' })).toBe(0);
      expect(livenessTrustListedMaxAgeMs({ [name]: ' 60000 ' })).toBe(60_000);
      expect(livenessTrustListedMaxAgeMs({ ...legacy, [name]: '600000' })).toBe(600_000);
      expect(livenessTrustListedMaxAgeMs({ ...legacy, [name]: '0' })).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(['ten', '-1', '1.5', '1e3', '600000ms', '99999999999999999999'])(
      'an invalid value %p keeps the default and is logged once',
      (raw) => {
        expect(livenessTrustListedMaxAgeMs({ [name]: raw })).toBe(600_000);
        expect(livenessTrustListedMaxAgeMs({ [name]: raw })).toBe(600_000);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toBe(
          `${name}=${JSON.stringify(raw)} is not a non-negative integer (ms; 0 = off); using 600000`,
        );
      },
    );

    it('under the legacy preset an invalid value keeps 0 and says so', () => {
      expect(livenessTrustListedMaxAgeMs({ ...legacy, [name]: 'soon' })).toBe(0);
      expect(warn).toHaveBeenCalledWith(`${name}="soon" is not a non-negative integer (ms; 0 = off); using 0`);
    });
  });
});
