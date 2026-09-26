import { Country, JobType } from '@ever-jobs/models';
import {
  buildBoardQuery,
  countryCodeForCountry,
  countryCodeFromName,
  hasBoardCriteria,
  planBoardWindow,
  sanitiseFacetValue,
  sanitiseQueryText,
} from '../src/wttj.query';

const NOW_SEC = 1_790_300_000;

/**
 * Spec 1705 work item A — the pure board-query builder and page planner.
 */
describe('WTTJ board query (Spec 1705 A)', () => {
  describe('buildBoardQuery', () => {
    it('maps the full criteria set to facet and numeric filters', () => {
      const q = buildBoardQuery(
        {
          searchTerm: 'developer',
          location: 'Paris, France',
          isRemote: true,
          jobType: JobType.INTERNSHIP,
          hoursOld: 24,
        },
        NOW_SEC,
      );
      expect(q.query).toBe('developer');
      expect(q.facetFilters).toEqual([
        ['offices.city:Paris', 'offices.state:Paris'],
        ['offices.country_code:FR'],
        ['remote:fulltime'],
        ['contract_type:internship'],
      ]);
      expect(q.numericFilters).toEqual([`published_at_timestamp>${NOW_SEC - 86400}`]);
      expect(q.ignored).toEqual([]);
    });

    it('an empty input is the newest-first catch-all', () => {
      expect(buildBoardQuery({}, NOW_SEC)).toEqual({
        query: '',
        facetFilters: [],
        numericFilters: [],
        ignored: [],
      });
    });

    it('the default country (USA) adds no country facet', () => {
      expect(buildBoardQuery({ searchTerm: 'x', country: Country.USA }, NOW_SEC).facetFilters).toEqual([]);
      expect(buildBoardQuery({ searchTerm: 'x', country: Country.WORLDWIDE }, NOW_SEC).facetFilters).toEqual([]);
      expect(buildBoardQuery({ searchTerm: 'x', country: Country.US_CANADA }, NOW_SEC).facetFilters).toEqual([]);
    });

    it('an explicit non-US country adds its ISO code', () => {
      expect(buildBoardQuery({ country: Country.GERMANY }, NOW_SEC).facetFilters).toEqual([
        ['offices.country_code:DE'],
      ]);
      expect(buildBoardQuery({ country: Country.UK }, NOW_SEC).facetFilters).toEqual([
        ['offices.country_code:GB'],
      ]);
    });

    it('a country in the location wins over input.country', () => {
      expect(
        buildBoardQuery({ location: 'Berlin, Germany', country: Country.FRANCE }, NOW_SEC).facetFilters,
      ).toEqual([['offices.city:Berlin', 'offices.state:Berlin'], ['offices.country_code:DE']]);
      expect(
        buildBoardQuery({ location: 'New York, United States', country: Country.FRANCE }, NOW_SEC).facetFilters,
      ).toEqual([['offices.city:New York', 'offices.state:New York'], ['offices.country_code:US']]);
    });

    it('location "Remote" means fully remote', () => {
      expect(buildBoardQuery({ location: 'Remote' }, NOW_SEC).facetFilters).toEqual([['remote:fulltime']]);
      expect(buildBoardQuery({ location: 'Remote, France' }, NOW_SEC).facetFilters).toEqual([
        ['offices.country_code:FR'],
        ['remote:fulltime'],
      ]);
    });

    it('a city alone gives the city/state OR-group', () => {
      expect(buildBoardQuery({ location: 'Lyon' }, NOW_SEC).facetFilters).toEqual([
        ['offices.city:Lyon', 'offices.state:Lyon'],
      ]);
    });

    it('a leading "-" (negation) and quotes are stripped from user values', () => {
      const q = buildBoardQuery({ location: '-Paris', searchTerm: '"data"  \u0000 engineer' }, NOW_SEC);
      expect(q.facetFilters[0]).toEqual(['offices.city:Paris', 'offices.state:Paris']);
      expect(q.query).toBe('data engineer');
    });

    it('location "Hybrid" asks for partial / occasional remote; isRemote still wins', () => {
      expect(buildBoardQuery({ location: 'Hybrid' }, NOW_SEC)).toMatchObject({
        query: '',
        facetFilters: [['remote:partial', 'remote:punctual']],
      });
      expect(buildBoardQuery({ location: 'Hybrid', isRemote: true }, NOW_SEC).facetFilters).toEqual([
        ['remote:fulltime'],
      ]);
    });

    it('a region alone filters on the region as typed', () => {
      expect(buildBoardQuery({ location: 'California' }, NOW_SEC).facetFilters).toEqual([
        ['offices.state:California', 'offices.city:California'],
      ]);
    });

    it('"Worldwide" is recognised and filters nothing', () => {
      expect(buildBoardQuery({ searchTerm: 'chef', location: 'Worldwide' }, NOW_SEC)).toMatchObject({
        query: 'chef',
        facetFilters: [],
      });
    });

    it('a location the parser cannot read at all goes into the query text', () => {
      // Labels over the parser's length limit are not parsed.
      const label = `Zone ${'industrielle '.repeat(25)}`.trim();
      const q = buildBoardQuery({ searchTerm: 'chef', location: label }, NOW_SEC);
      expect(q.facetFilters).toEqual([]);
      expect(q.query.startsWith('chef Zone industrielle')).toBe(true);
    });

    it('a location with no letters or digits is dropped', () => {
      const q = buildBoardQuery({ searchTerm: 'chef', location: '   ,  ' }, NOW_SEC);
      expect(q.facetFilters).toEqual([]);
      expect(q.query).toBe('chef');
    });

    it('job types map to their contract tokens; one no token maps to is ignored', () => {
      expect(buildBoardQuery({ jobType: JobType.CONTRACT }, NOW_SEC).facetFilters).toEqual([
        ['contract_type:freelance'],
      ]);
      expect(buildBoardQuery({ jobType: JobType.OTHER }, NOW_SEC).facetFilters).toEqual([
        ['contract_type:other', 'contract_type:vie', 'contract_type:graduate_program', 'contract_type:idv'],
      ]);
      const permanent = buildBoardQuery({ jobType: JobType.PERMANENT }, NOW_SEC);
      expect(permanent.facetFilters).toEqual([]);
      expect(permanent.ignored).toEqual(['jobType=permanent']);
    });

    it('hoursOld is a posting-age cut-off; zero, negative or non-finite adds nothing', () => {
      expect(buildBoardQuery({ hoursOld: 168 }, NOW_SEC).numericFilters).toEqual([
        `published_at_timestamp>${NOW_SEC - 168 * 3600}`,
      ]);
      expect(buildBoardQuery({ hoursOld: 1.5 }, NOW_SEC).numericFilters).toEqual([
        `published_at_timestamp>${NOW_SEC - 5400}`,
      ]);
      for (const hoursOld of [0, -3, Number.NaN]) {
        expect(buildBoardQuery({ hoursOld }, NOW_SEC).numericFilters).toEqual([]);
      }
    });

    it('distance is ignored', () => {
      expect(buildBoardQuery({ location: 'Lyon', distance: 25 }, NOW_SEC).facetFilters).toEqual([
        ['offices.city:Lyon', 'offices.state:Lyon'],
      ]);
    });
  });

  describe('sanitisers', () => {
    it('sanitiseQueryText collapses whitespace, drops quotes and control characters, caps length', () => {
      expect(sanitiseQueryText('  a\t"b"\n c ')).toBe('a b c');
      expect(sanitiseQueryText(42)).toBe('');
      expect(sanitiseQueryText('x'.repeat(400))).toHaveLength(256);
    });

    it('sanitiseFacetValue also strips leading dashes and caps length', () => {
      expect(sanitiseFacetValue('--Paris')).toBe('Paris');
      expect(sanitiseFacetValue(' - ')).toBeNull();
      expect(sanitiseFacetValue(null)).toBeNull();
      expect(sanitiseFacetValue('y'.repeat(150))).toHaveLength(100);
    });
  });

  describe('country codes', () => {
    it('resolves configured countries, ISO codes and ISO names', () => {
      expect(countryCodeFromName('France')).toBe('FR');
      expect(countryCodeFromName('United Kingdom')).toBe('GB');
      expect(countryCodeFromName('uk')).toBe('GB');
      expect(countryCodeFromName('de')).toBe('DE');
      expect(countryCodeFromName('Luxembourg')).toBe('LU');
      expect(countryCodeFromName('Atlantis')).toBeNull();
      expect(countryCodeFromName('')).toBeNull();
    });

    it('countryCodeForCountry skips the unfiltered defaults', () => {
      expect(countryCodeForCountry(Country.USA)).toBeNull();
      expect(countryCodeForCountry(Country.WORLDWIDE)).toBeNull();
      expect(countryCodeForCountry(undefined)).toBeNull();
      expect(countryCodeForCountry(Country.SPAIN)).toBe('ES');
    });
  });

  describe('hasBoardCriteria', () => {
    it('is true for each search criterion', () => {
      expect(hasBoardCriteria({ searchTerm: 'data' })).toBe(true);
      expect(hasBoardCriteria({ location: 'Paris' })).toBe(true);
      expect(hasBoardCriteria({ hoursOld: 24 })).toBe(true);
      expect(hasBoardCriteria({ isRemote: true })).toBe(true);
      expect(hasBoardCriteria({ jobType: JobType.FULL_TIME })).toBe(true);
    });

    it('is false for the DTO defaults alone', () => {
      expect(hasBoardCriteria({})).toBe(false);
      expect(
        hasBoardCriteria({ searchTerm: '  ', location: '', isRemote: false, hoursOld: 0, country: Country.USA, distance: 50 }),
      ).toBe(false);
    });
  });

  describe('planBoardWindow', () => {
    it('150 wanted reads 100-hit pages from page 0', () => {
      expect(planBoardWindow({ resultsWanted: 150 })).toEqual({
        offset: 0,
        resultsWanted: 150,
        want: 150,
        truncated: false,
        hitsPerPage: 100,
        firstPage: 0,
        skip: 0,
      });
    });

    it('offset 130 + 20 wanted fits one page', () => {
      const w = planBoardWindow({ offset: 130, resultsWanted: 20 });
      expect(w).toMatchObject({ want: 20, hitsPerPage: 25, firstPage: 5, skip: 5 });
      // The slice [130, 150) sits inside page 5 of 25-hit pages: [125, 150).
      expect(w!.firstPage * w!.hitsPerPage + w!.skip).toBe(130);
      expect(w!.skip + w!.want).toBeLessThanOrEqual(w!.hitsPerPage);
    });

    it('offset 990 + 50 wanted is cut to the window', () => {
      expect(planBoardWindow({ offset: 990, resultsWanted: 50 })).toMatchObject({
        want: 10,
        truncated: true,
        hitsPerPage: 10,
        firstPage: 99,
        skip: 0,
      });
    });

    it('offset at or past the window has no plan', () => {
      expect(planBoardWindow({ offset: 1000 })).toBeNull();
      expect(planBoardWindow({ offset: 5000, resultsWanted: 1 })).toBeNull();
    });

    it('defaults: 15 results from offset 0; junk values fall back', () => {
      expect(planBoardWindow({})).toMatchObject({ want: 15, hitsPerPage: 15, firstPage: 0, skip: 0 });
      expect(planBoardWindow({ resultsWanted: 0, offset: -4 })).toMatchObject({ want: 15, offset: 0 });
      expect(planBoardWindow({ resultsWanted: 2000 })).toMatchObject({ want: 1000, truncated: true, hitsPerPage: 100 });
    });

    it('every plan reads exactly the requested slice', () => {
      for (const offset of [0, 1, 7, 99, 130, 333, 999]) {
        for (const resultsWanted of [1, 3, 20, 50, 99, 100, 101, 250]) {
          const w = planBoardWindow({ offset, resultsWanted })!;
          expect(w.firstPage * w.hitsPerPage + w.skip).toBe(offset);
          expect(w.hitsPerPage).toBeGreaterThanOrEqual(1);
          expect(w.hitsPerPage).toBeLessThanOrEqual(100);
        }
      }
    });
  });
});
