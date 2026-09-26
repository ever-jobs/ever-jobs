import 'reflect-metadata';
import { JobType } from '@ever-jobs/models';
import {
  buildLocation,
  detectWorkplace,
  getJobType,
  isJobRemote,
  IndeedJob,
} from '../src/indeed.utils';
import {
  INDEED_ATTRIBUTE_MAPPING_ENV,
  INDEED_DEFAULT_MAX_PAGES,
  INDEED_FORMATTED_LOCATION_ENV,
  INDEED_JOB_TYPE_ATTRIBUTE_KEYS,
  INDEED_MAX_PAGES_ENV,
  INDEED_REMOTE_ATTRIBUTE_KEY,
  readIndeedMappingOptions,
  readIndeedMaxPages,
} from '../src/indeed.constants';

const LEGACY = { attributeMapping: false, formattedLocation: false } as const;

function job(
  attributes: { key?: string | null; label?: string | null }[] = [],
  formattedLong: string | null = null,
  extra: Record<string, unknown> = {},
): IndeedJob {
  return {
    attributes,
    location: { formatted: formattedLong === null ? null : { long: formattedLong } },
    ...extra,
  };
}

/**
 * Spec 1702 — Indeed attribute keys are opaque codes, not words.
 */
describe('Indeed utils — Spec 1702', () => {
  describe('detectWorkplace', () => {
    it('reads the Remote attribute code (DSQF7)', () => {
      expect(detectWorkplace(job([{ key: 'DSQF7', label: 'Remote' }]))).toEqual({
        isRemote: true,
        workFromHomeType: 'Remote',
      });
      expect(INDEED_REMOTE_ATTRIBUTE_KEY).toBe('DSQF7');
    });

    it('reads a whole workplace label under an unknown key', () => {
      for (const label of ['Remote', 'remote', 'Work from home', 'Work-from-home', 'Fully remote', '100% remote', 'Temporarily remote', 'WFH']) {
        expect(detectWorkplace(job([{ key: 'ZZZZZ', label }])).isRemote).toBe(true);
      }
    });

    it('ignores skill labels that merely start with "Remote"', () => {
      const result = detectWorkplace(
        job(
          [
            { key: 'SYN01', label: 'Remote desktop support' },
            { key: 'SYN02', label: 'Remote sensing' },
            { key: 'SYN03', label: 'Remote access software' },
          ],
          'New York, NY 10017',
        ),
      );
      expect(result).toEqual({ isRemote: false, workFromHomeType: null });
    });

    it('never reads the description or the title', () => {
      const onSite = job([{ key: 'CF3CP', label: 'Full-time' }], 'New York, NY 10017', {
        title: 'Remote Support Engineer',
        description: { html: '<p>No remote work; occasionally work from home.</p>' },
      });
      expect(detectWorkplace(onSite)).toEqual({ isRemote: false, workFromHomeType: null });
    });

    it('reads the head of the formatted location', () => {
      expect(detectWorkplace(job([], 'Remote in Austin, TX 78701'))).toEqual({
        isRemote: true,
        workFromHomeType: 'Remote',
      });
      expect(detectWorkplace(job([], 'Remote')).isRemote).toBe(true);
      expect(detectWorkplace(job([], 'Temporarily Remote in Chicago, IL')).isRemote).toBe(true);
      // A place name that merely contains the word is not a remote head.
      expect(detectWorkplace(job([], 'Remoteville, OH')).isRemote).toBe(false);
      expect(detectWorkplace(job([], 'Austin, TX (Remote)')).isRemote).toBe(false);
    });

    it('falls back to formatted.short when long is missing', () => {
      const j: IndeedJob = { attributes: [], location: { formatted: { short: 'Remote' } } };
      expect(detectWorkplace(j).isRemote).toBe(true);
    });

    it('reports hybrid from a label or a location head, without claiming remote', () => {
      expect(detectWorkplace(job([], 'Hybrid work in London'))).toEqual({
        isRemote: false,
        workFromHomeType: 'Hybrid',
      });
      expect(detectWorkplace(job([], 'Hybrid remote in Seattle, WA 98101'))).toEqual({
        isRemote: false,
        workFromHomeType: 'Hybrid',
      });
      for (const label of ['Hybrid work', 'Hybrid', 'Hybrid remote']) {
        expect(detectWorkplace(job([{ key: 'SYN03', label }], 'London'))).toEqual({
          isRemote: false,
          workFromHomeType: 'Hybrid',
        });
      }
      expect(detectWorkplace(job([{ key: 'SYN09', label: 'Hybrid cloud' }])).workFromHomeType).toBeNull();
    });

    it('lets an explicit remote signal win over a hybrid one', () => {
      expect(
        detectWorkplace(job([{ key: 'SYN03', label: 'Hybrid work' }, { key: 'DSQF7', label: 'Remote' }])),
      ).toEqual({ isRemote: true, workFromHomeType: 'Remote' });
    });

    it('still honours the pre-1702 key', () => {
      expect(detectWorkplace(job([{ key: 'remotejob', label: 'x' }])).isRemote).toBe(true);
    });

    it('is total on junk input', () => {
      expect(detectWorkplace(null)).toEqual({ isRemote: false, workFromHomeType: null });
      expect(detectWorkplace({ attributes: [null as never, { key: 7 as never, label: 9 as never }] })).toEqual({
        isRemote: false,
        workFromHomeType: null,
      });
    });

    it('{ attributeMapping: false } restores the pre-1702 rule', () => {
      expect(detectWorkplace(job([{ key: 'DSQF7', label: 'Remote' }], 'Remote'), LEGACY)).toEqual({
        isRemote: false,
        workFromHomeType: null,
      });
      expect(detectWorkplace(job([{ key: 'remotejob', label: 'Remote' }]), LEGACY)).toEqual({
        isRemote: true,
        workFromHomeType: null,
      });
    });
  });

  describe('isJobRemote (compatibility wrapper)', () => {
    it('reads the attribute code', () => {
      expect(isJobRemote([{ key: 'DSQF7', label: 'Remote' }])).toBe(true);
      expect(isJobRemote([{ key: 'CF3CP', label: 'Full-time' }])).toBe(false);
      expect(isJobRemote(null)).toBe(false);
    });

    it('keeps the pre-1702 rule behind the option', () => {
      expect(isJobRemote([{ key: 'DSQF7', label: 'Remote' }], LEGACY)).toBe(false);
      expect(isJobRemote([{ key: 'remotejob', label: '' }], LEGACY)).toBe(true);
    });
  });

  describe('getJobType', () => {
    it('maps employment-type codes', () => {
      expect(getJobType([{ key: 'CF3CP', label: 'Full-time' }])).toEqual([JobType.FULL_TIME]);
      expect(getJobType([{ key: '75GKK', label: 'whatever' }])).toEqual([JobType.PART_TIME]);
      expect(getJobType([{ key: 'NJXCK', label: 'Contract' }])).toEqual([JobType.CONTRACT]);
      expect(getJobType([{ key: 'VDTG7', label: 'Internship' }])).toEqual([JobType.INTERNSHIP]);
      expect(Object.keys(INDEED_JOB_TYPE_ATTRIBUTE_KEYS)).toHaveLength(4);
    });

    it('resolves a whole label when the key is not a known code', () => {
      expect(getJobType([{ key: 'SYN05', label: 'Temporary' }])).toEqual([JobType.TEMPORARY]);
      expect(getJobType([{ key: 'SYN04', label: 'Permanent' }])).toEqual([JobType.PERMANENT]);
      expect(getJobType([{ key: 'SYN07', label: ' Part-time ' }])).toEqual([JobType.PART_TIME]);
    });

    it('does not read skill or benefit labels as job types', () => {
      expect(
        getJobType([
          { key: 'SYN06', label: 'Contract management' },
          { key: 'SYN08', label: '401(k)' },
          { key: 'DSQF7', label: 'Remote' },
          { key: 'SYN01', label: 'Remote desktop support' },
        ]),
      ).toBeNull();
    });

    it('collects several types once each, in attribute order', () => {
      expect(
        getJobType([
          { key: 'CF3CP', label: 'Full-time' },
          { key: 'SYN04', label: 'Permanent' },
          { key: 'SYN10', label: 'Full-time' },
        ]),
      ).toEqual([JobType.FULL_TIME, JobType.PERMANENT]);
    });

    it('still resolves pre-1702 `job-types` keys', () => {
      expect(getJobType([{ key: 'job-types/fulltime', label: 'Full-time' }])).toEqual([JobType.FULL_TIME]);
    });

    it('is total on junk input', () => {
      expect(getJobType(null)).toBeNull();
      expect(getJobType([])).toBeNull();
      expect(getJobType([null as never, { key: null, label: null }])).toBeNull();
    });

    it('{ attributeMapping: false } restores the pre-1702 rule', () => {
      expect(getJobType([{ key: 'CF3CP', label: 'Full-time' }], LEGACY)).toBeNull();
      expect(getJobType([{ key: 'SYN05', label: 'Temporary' }], LEGACY)).toBeNull();
      // The old rule did not de-duplicate.
      expect(
        getJobType(
          [
            { key: 'job-types/a', label: 'Full-time' },
            { key: 'job-types/b', label: 'Full-time' },
          ],
          LEGACY,
        ),
      ).toEqual([JobType.FULL_TIME, JobType.FULL_TIME]);
    });
  });

  describe('buildLocation', () => {
    it('prefers structured fields and keeps the formatted label verbatim', () => {
      const loc = buildLocation({
        city: 'Austin',
        state: 'TX',
        country: null,
        countryCode: 'US',
        postalCode: '78701',
        formatted: { long: 'Remote in Austin, TX 78701' },
      });
      expect(loc).toMatchObject({
        city: 'Austin',
        state: 'TX',
        country: 'US',
        postalCode: '78701',
        text: 'Remote in Austin, TX 78701',
      });
      expect(loc.city?.startsWith('Remote')).toBe(false);
    });

    it('prefers the country name over the code', () => {
      expect(
        buildLocation({ city: 'Denver', state: 'CO', country: 'United States', countryCode: 'US' }).country,
      ).toBe('United States');
    });

    it('parses the formatted label only when there is no structured geography', () => {
      const loc = buildLocation({
        city: null,
        state: null,
        country: null,
        countryCode: 'US',
        formatted: { long: 'Remote in New York, NY 10001' },
      });
      expect(loc).toMatchObject({
        city: 'New York',
        state: 'NY',
        country: 'US',
        postalCode: '10001',
        text: 'Remote in New York, NY 10001',
      });
      expect(loc.name).toBeUndefined();

      expect(
        buildLocation({ countryCode: 'GB', formatted: { long: 'Hybrid work in London' } }),
      ).toMatchObject({ city: 'London', country: 'GB', text: 'Hybrid work in London' });
    });

    it('does not mint a place for a bare "Remote" label', () => {
      const loc = buildLocation({ countryCode: 'US', formatted: { long: 'Remote' } });
      // The shared parser's process-wide convention decides: no city, or the legacy 'Remote'.
      expect([null, undefined, 'Remote']).toContain(loc.city);
      expect(loc.state ?? null).toBeNull();
      expect(loc.text).toBe('Remote');
      expect(loc.country).toBe('US');
    });

    it('keeps the pre-1702 shape keys even when everything is missing', () => {
      const loc = buildLocation(null);
      expect(loc).toEqual(expect.objectContaining({ city: null, state: null, country: null }));
      expect(loc.text).toBeUndefined();
      expect(loc.postalCode).toBeUndefined();
    });

    it('{ formattedLocation: false } restores the pre-1702 { city, state, country }', () => {
      const loc = buildLocation(
        {
          city: null,
          state: null,
          country: null,
          countryCode: 'US',
          postalCode: '10001',
          formatted: { long: 'Remote in New York, NY 10001' },
        },
        LEGACY,
      );
      expect({ ...loc }).toEqual({ city: null, state: null, country: null });
    });
  });

  describe('switches', () => {
    it('default ON and honour the usual off values', () => {
      expect(readIndeedMappingOptions({})).toEqual({ attributeMapping: true, formattedLocation: true });
      for (const off of ['false', '0', 'no', 'off', ' OFF ']) {
        expect(
          readIndeedMappingOptions({ [INDEED_ATTRIBUTE_MAPPING_ENV]: off, [INDEED_FORMATTED_LOCATION_ENV]: off }),
        ).toEqual({ attributeMapping: false, formattedLocation: false });
      }
      expect(readIndeedMappingOptions({ [INDEED_ATTRIBUTE_MAPPING_ENV]: 'maybe' }).attributeMapping).toBe(true);
    });

    it('cap pages at 10 unless told otherwise', () => {
      expect(INDEED_DEFAULT_MAX_PAGES).toBe(10);
      expect(readIndeedMaxPages({})).toBe(10);
      expect(readIndeedMaxPages({ [INDEED_MAX_PAGES_ENV]: '3' })).toBe(3);
      for (const unlimited of ['0', 'off', 'none', 'unlimited']) {
        expect(readIndeedMaxPages({ [INDEED_MAX_PAGES_ENV]: unlimited })).toBe(0);
      }
      for (const junk of ['-1', '2.5', 'lots', '9999999']) {
        expect(readIndeedMaxPages({ [INDEED_MAX_PAGES_ENV]: junk })).toBe(10);
      }
    });
  });
});
