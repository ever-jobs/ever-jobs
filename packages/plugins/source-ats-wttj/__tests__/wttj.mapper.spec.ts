import * as fs from 'fs';
import * as path from 'path';
import { CompensationInterval, JobType, LocationDto } from '@ever-jobs/models';
import {
  assembleDescriptionHtml,
  companyIndustry,
  companyLogoUrl,
  companyNumEmployees,
  contractTokensForJobType,
  countryCodeFromOffices,
  escapeHtml,
  experienceRangeFrom,
  jobTypesFromContract,
  legacyAssembleDescription,
  legacyRemoteFromToken,
  locationKey,
  missionsOf,
  officeCountryCode,
  officeLocations,
  remoteFromToken,
  structuredCompensation,
  urlLocale,
  WTTJ_CONTRACT_JOB_TYPES,
} from '../src/wttj.mapper';
import { WttjJobHit } from '../src/wttj.types';

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'wttj-hits.json'), 'utf8'),
) as { hits: WttjJobHit[] };

function hit(index: number): WttjJobHit {
  return JSON.parse(JSON.stringify(FIXTURE.hits[index])) as WttjJobHit;
}

/**
 * Spec 1705 work item B — the pure hit-mapping helpers, table by table.
 */
describe('WTTJ hit mapping helpers (Spec 1705 B)', () => {
  describe('remoteFromToken (B1)', () => {
    it.each([
      ['fulltime', true, 'Remote'],
      ['partial', false, 'Hybrid'],
      ['punctual', false, 'Hybrid'],
      ['no', false, null],
      ['FULLTIME', true, 'Remote'],
      [' partial ', false, 'Hybrid'],
    ])('token %p gives isRemote=%p, workFromHomeType=%p', (token, isRemote, wfh) => {
      expect(remoteFromToken(token, ['Backend engineer'])).toEqual({ isRemote, workFromHomeType: wfh });
    });

    it('regression: "unknown" is not remote (the old rule counted it as remote)', () => {
      expect(remoteFromToken('unknown', ['Commis de cuisine', 'Nantes'])).toEqual({
        isRemote: false,
        workFromHomeType: null,
      });
      expect(legacyRemoteFromToken('unknown', ['Commis de cuisine', 'Nantes'])).toBe(true);
    });

    it('an explicit "no" wins over a title that says remote', () => {
      expect(remoteFromToken('no', ['Remote Sommelier'])).toEqual({ isRemote: false, workFromHomeType: null });
      for (const token of ['none', 'false', 'onsite', 'on-site', 'on site']) {
        expect(remoteFromToken(token, ['Remote Sommelier']).isRemote).toBe(false);
      }
    });

    it('a missing or unrecognised token falls back to the remote regex over the free text', () => {
      expect(remoteFromToken(undefined, ['Full remote backend engineer'])).toEqual({
        isRemote: true,
        workFromHomeType: 'Remote',
      });
      expect(remoteFromToken(null, [null, 'Télétravail'])).toEqual({ isRemote: true, workFromHomeType: 'Remote' });
      expect(remoteFromToken('sometimes', ['Engineer', 'Paris'])).toEqual({ isRemote: false, workFromHomeType: null });
      expect(remoteFromToken('', [])).toEqual({ isRemote: false, workFromHomeType: null });
    });

    it('legacy rule: every token but an explicit "no" is remote', () => {
      expect(legacyRemoteFromToken('partial', ['x'])).toBe(true);
      expect(legacyRemoteFromToken('punctual', ['x'])).toBe(true);
      expect(legacyRemoteFromToken('no', ['Engineer'])).toBe(false);
      // The old rule then still read the title, so "no" + a remote title was remote.
      expect(legacyRemoteFromToken('no', ['Remote Sommelier'])).toBe(true);
      expect(legacyRemoteFromToken(undefined, ['Full remote backend engineer'])).toBe(true);
      expect(legacyRemoteFromToken(undefined, ['Engineer'])).toBe(false);
    });
  });

  describe('jobTypesFromContract (B4)', () => {
    it.each([
      ['full_time', JobType.FULL_TIME],
      ['part_time', JobType.PART_TIME],
      ['internship', JobType.INTERNSHIP],
      ['apprenticeship', JobType.APPRENTICESHIP],
      ['temporary', JobType.TEMPORARY],
      ['freelance', JobType.CONTRACT],
      ['volunteer', JobType.VOLUNTEER],
      ['other', JobType.OTHER],
      ['vie', JobType.OTHER],
      ['graduate_program', JobType.OTHER],
      ['idv', JobType.OTHER],
    ])('%p maps to %p', (token, jobType) => {
      expect(jobTypesFromContract(token, 'fr')).toEqual([jobType]);
    });

    it('covers every live token, and nothing else', () => {
      expect(Object.keys(WTTJ_CONTRACT_JOB_TYPES).sort()).toEqual(
        [
          'apprenticeship', 'freelance', 'full_time', 'graduate_program', 'idv', 'internship',
          'other', 'part_time', 'temporary', 'vie', 'volunteer',
        ],
      );
    });

    it('a new token resolves through the shared vocabulary, else OTHER', () => {
      expect(jobTypesFromContract('seasonal', 'fr')).toEqual([JobType.TEMPORARY]);
      expect(jobTypesFromContract('FULL_TIME', 'en')).toEqual([JobType.FULL_TIME]);
      expect(jobTypesFromContract('zz_new_token', 'en')).toEqual([JobType.OTHER]);
    });

    it('a missing token gives null', () => {
      expect(jobTypesFromContract(null)).toBeNull();
      expect(jobTypesFromContract('  ')).toBeNull();
    });

    it('contractTokensForJobType is the reverse of the table', () => {
      expect(contractTokensForJobType(JobType.INTERNSHIP)).toEqual(['internship']);
      expect(contractTokensForJobType(JobType.APPRENTICESHIP)).toEqual(['apprenticeship']);
      expect(contractTokensForJobType(JobType.CONTRACT)).toEqual(['freelance']);
      expect(contractTokensForJobType(JobType.OTHER)).toEqual(['other', 'vie', 'graduate_program', 'idv']);
      expect(contractTokensForJobType(JobType.PERMANENT)).toEqual([]);
      expect(contractTokensForJobType(undefined)).toEqual([]);
    });
  });

  describe('structuredCompensation (B3)', () => {
    it('yearly EUR range', () => {
      expect({ ...structuredCompensation(hit(0)) }).toEqual({
        interval: CompensationInterval.YEARLY,
        minAmount: 43000,
        maxAmount: 51000,
        currency: 'EUR',
      });
    });

    it('monthly range keeps the monthly interval', () => {
      expect({ ...structuredCompensation(hit(1)) }).toEqual({
        interval: CompensationInterval.MONTHLY,
        minAmount: 1200,
        maxAmount: 1500,
        currency: 'EUR',
      });
    });

    it('yearly minimum only', () => {
      expect({ ...structuredCompensation(hit(2)) }).toEqual({
        interval: CompensationInterval.YEARLY,
        minAmount: 90000,
        currency: 'USD',
      });
    });

    it('no currency gives no structured value (never a silent USD)', () => {
      expect(structuredCompensation(hit(3))).toBeNull();
      expect(structuredCompensation({ salary_minimum: 1, salary_currency: 'euro' })).toBeNull();
    });

    it('zero amounts and absent fields give null', () => {
      expect(structuredCompensation(hit(5))).toBeNull();
      expect(structuredCompensation(hit(4))).toBeNull();
      expect(structuredCompensation({})).toBeNull();
    });

    it('an unknown period gives no interval, and a swapped range is put in order', () => {
      const comp = structuredCompensation({
        salary_minimum: 60000,
        salary_maximum: 50000,
        salary_currency: 'gbp',
        salary_period: 'per_fortnight',
      });
      expect(comp).toMatchObject({ minAmount: 50000, maxAmount: 60000, currency: 'GBP' });
      expect(comp?.interval).toBeUndefined();
    });
  });

  describe('description (B2)', () => {
    it('summary first, then missions as a list, then the profile; text is escaped', () => {
      const html = assembleDescriptionHtml(hit(0));
      expect(html).toBe(
        '<p>Build the control software for our robot arms.</p>\n' +
          '<ul><li>Design motion-planning services.</li><li>Review code &amp; mentor juniors.</li>' +
          '<li>Ship firmware updates &lt;safely&gt;.</li></ul>\n' +
          '<p>You have <strong>5 years</strong> of C++ experience.</p>',
      );
    });

    it('a legacy single-string mission is kept as a paragraph', () => {
      expect(assembleDescriptionHtml(hit(1))).toBe(
        '<p>Pilotez nos projets digitaux.</p>\n<p>Piloter la refonte du site.</p>',
      );
    });

    it('blank missions are dropped, and an empty hit gives null', () => {
      expect(missionsOf(['a', '  ', 3, null, ' b '])).toEqual(['a', 'b']);
      expect(missionsOf(' single ')).toEqual(['single']);
      expect(missionsOf(undefined)).toEqual([]);
      expect(assembleDescriptionHtml(hit(5))).toBe(
        '<p>Rejoignez la brigade.</p>\n<ul><li>Préparer les entrées.</li></ul>',
      );
      expect(assembleDescriptionHtml({})).toBeNull();
    });

    it('the legacy layout drops list missions and the summary, as before', () => {
      expect(legacyAssembleDescription(hit(0))).toBe('<p>You have <strong>5 years</strong> of C++ experience.</p>');
      expect(legacyAssembleDescription(hit(1))).toBe('Piloter la refonte du site.');
      expect(legacyAssembleDescription({ summary: ' Only a summary ' })).toBe('Only a summary');
    });

    it('escapeHtml escapes the five special characters', () => {
      expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
        '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
      );
    });
  });

  describe('offices and country (B5)', () => {
    it('one location per office, deduplicated', () => {
      const offices = [...(hit(0).offices ?? []), { city: 'paris', state: 'ile-de-france', country: 'france' }, {}];
      const locations = officeLocations(offices);
      expect(locations).toHaveLength(2);
      expect(locations[0]).toBeInstanceOf(LocationDto);
      expect(locations.map((l) => l.city)).toEqual(['Paris', 'Berlin']);
      expect(officeLocations(null)).toEqual([]);
    });

    it('country codes are upper-cased and validated', () => {
      expect(officeCountryCode({ country_code: 'de' })).toBe('DE');
      expect(officeCountryCode({ country_code: 'DEU' })).toBeNull();
      expect(officeCountryCode(null)).toBeNull();
      const offices = [{ city: 'X', country_code: 'bad!' }, { city: 'Y', country_code: 'es' }];
      expect(countryCodeFromOffices(offices, offices[0])).toBe('ES');
      expect(countryCodeFromOffices(hit(0).offices, hit(0).offices?.[0])).toBe('FR');
    });

    it('locationKey matches the office dedupe key', () => {
      expect(locationKey(new LocationDto({ city: ' Paris ', country: 'FRANCE' }))).toBe('paris||france');
    });
  });

  describe('company metadata (B5)', () => {
    it('logo, headcount, industry', () => {
      const h = hit(0);
      expect(companyLogoUrl(h.organization)).toBe('https://cdn.example.test/logos/acme-robotics.png');
      expect(companyNumEmployees(h.organization)).toBe('800');
      expect(companyIndustry(h.sectors)).toBe('IT / Digital, SaaS / Cloud Services');
    });

    it('missing or unusable values give null', () => {
      expect(companyLogoUrl({ logo: { url: 'javascript:alert(1)' } })).toBeNull();
      expect(companyLogoUrl(null)).toBeNull();
      expect(companyNumEmployees({ nb_employees: 0 })).toBeNull();
      expect(companyIndustry([])).toBeNull();
      expect(companyIndustry(null)).toBeNull();
    });

    it('experience range only when flagged', () => {
      expect(experienceRangeFrom(hit(0))).toBe('5+ years');
      expect(experienceRangeFrom(hit(2))).toBe('6+ months');
      expect(experienceRangeFrom(hit(1))).toBeNull();
      expect(experienceRangeFrom({ experience_level_minimum: 3 })).toBeNull();
      expect(experienceRangeFrom({ experience_level_minimum: 1, has_experience_level_minimum: true })).toBe('1+ year');
      expect(experienceRangeFrom({ experience_level_minimum: 2.5, has_experience_level_minimum: true })).toBe(
        '2.5+ years',
      );
    });
  });

  describe('urlLocale (B6)', () => {
    it('keeps a served UI locale and maps any other language to en', () => {
      expect(urlLocale('fr', true)).toBe('fr');
      expect(urlLocale('ES', true)).toBe('es');
      expect(urlLocale('de', true)).toBe('en');
      expect(urlLocale(null, true)).toBe('en');
    });

    it('without the guard, the posting language is used as before', () => {
      expect(urlLocale('de', false)).toBe('de');
      expect(urlLocale(undefined, false)).toBe('en');
    });
  });
});
