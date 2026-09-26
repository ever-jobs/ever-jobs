import { JobType } from '@ever-jobs/models';
import { SOLIDJOBS_DIVISIONS_ALL } from '../src/solidjobs.constants';
import {
  buildSolidJobsFilter,
  foldText,
  hasContractForm,
  humaniseCode,
  isCountryLevelLabel,
  isMappable,
  matchesJobType,
  matchesLocationNeedle,
  orderDivisionsByHints,
  parseLocationNeedle,
  postedMs,
  searchTokens,
} from '../src/solidjobs.filters';
import { SolidJobsOffer } from '../src/solidjobs.types';

function offer(partial: Partial<SolidJobsOffer> = {}): SolidJobsOffer {
  return {
    jobOfferKey: 'k-1',
    title: 'Programista Java',
    division: 'IT',
    category: 'Developer',
    subCategory: 'Java',
    company: 'Acme Software',
    companyLogoUrl: null,
    salary: null,
    contractTime: 'full_time',
    locations: ['Warszawa'],
    benefits: [],
    isRemote: false,
    isHybrid: false,
    url: 'https://solid.jobs/o/acme0001/api',
    experienceLevel: 'Regular',
    skills: [],
    languages: [],
    description: '<p>x</p>',
    ...partial,
  };
}

/** Spec 1709 — pure client-side filter helpers of the Solid.Jobs plugin. */
describe('solidjobs.filters — Spec 1709', () => {
  describe('foldText', () => {
    it.each([
      ['Łódź', 'lodz'],
      ['Sprzedaży', 'sprzedazy'],
      ['KSIĘGOWA', 'ksiegowa'],
      ['  Kraków \n  Nowa   Huta ', 'krakow nowa huta'],
    ])('%j → %j', (input, expected) => {
      expect(foldText(input)).toBe(expected);
    });

    it('returns an empty string for non-strings', () => {
      expect(foldText(undefined)).toBe('');
      expect(foldText(42)).toBe('');
    });
  });

  it('splits search terms on whitespace, "/" and ","', () => {
    expect(searchTokens(' React/TypeScript,  java react ')).toEqual(['react', 'typescript', 'java']);
    expect(searchTokens(' , / ')).toEqual([]);
  });

  describe('parseLocationNeedle', () => {
    it.each([
      ['Warsaw', 'warszawa', false],
      ['Cracow, Poland', 'krakow', false],
      ['Breslau', 'wroclaw', false],
      ['Danzig', 'gdansk', false],
      ['Łódź', 'lodz', false],
      ['Warszawa, Mazowieckie', 'warszawa mazowieckie', false],
      ['Poland', null, false],
      ['Polska', null, false],
      ['PL', null, false],
      ['cała Polska', null, false],
      ['remote', null, true],
      ['Zdalnie', null, true],
      ['Praca zdalna', null, true],
      ['Remote, Poland', null, true],
      ['Kraków (remote)', 'krakow', true],
      ['', null, false],
    ])('%j', (input, needle, remote) => {
      expect(parseLocationNeedle(input)).toEqual({ needle, remote });
    });

    it('keeps a non-Latin needle instead of dropping the filter', () => {
      expect(parseLocationNeedle('Варшава').needle).toBe('варшава');
    });
  });

  describe('matchesLocationNeedle', () => {
    it('matches whole words in either direction', () => {
      const o = offer({ locations: ['Warszawa', 'Kraków'] });
      expect(matchesLocationNeedle(o, 'warszawa mazowieckie')).toBe(true);
      expect(matchesLocationNeedle(o, 'krakow')).toBe(true);
      expect(matchesLocationNeedle(offer({ locations: ['Warszawa-Wola'] }), 'warszawa')).toBe(true);
    });

    it('does not match a town whose name is the start of another', () => {
      expect(matchesLocationNeedle(offer({ locations: ['Koło'] }), 'kolobrzeg')).toBe(false);
      expect(matchesLocationNeedle(offer({ locations: ['Kołobrzeg'] }), 'kolo')).toBe(false);
    });

    it('does not match an offer without locations', () => {
      expect(matchesLocationNeedle(offer({ locations: null }), 'warszawa')).toBe(false);
    });
  });

  describe('matchesJobType', () => {
    it('reads contractTime for full and part time, excluding an unknown value', () => {
      expect(matchesJobType(offer(), JobType.FULL_TIME)).toBe(true);
      expect(matchesJobType(offer({ contractTime: 'part_time' }), JobType.PART_TIME)).toBe(true);
      expect(matchesJobType(offer({ contractTime: null }), JobType.FULL_TIME)).toBe(false);
    });

    it('treats B2B, UZ and UoD (primary or secondary) as contract, not UoP', () => {
      const salary = (employmentType: string) => ({
        from: 1,
        to: 2,
        currency: 'PLN',
        period: 'Month',
        employmentType,
      });
      expect(matchesJobType(offer({ salary: salary('UoP') }), JobType.CONTRACT)).toBe(false);
      expect(matchesJobType(offer({ salary: salary('b2b') }), JobType.CONTRACT)).toBe(true);
      expect(
        matchesJobType(offer({ salary: salary('UoP'), secondarySalary: salary('UoD') }), JobType.CONTRACT),
      ).toBe(true);
      expect(hasContractForm(offer({ salary: null, secondarySalary: salary('UZ') }))).toBe(true);
    });

    it.each([
      ['Stażysta w dziale IT', true],
      ['Praktykant – Tester', true],
      ['Software Engineering Intern', true],
      ['Trainee Developer', true],
      ['International Sales Manager', false],
      ['Internal Audit Specialist', false],
    ])('INTERNSHIP by title %j', (title, expected) => {
      expect(matchesJobType(offer({ title }), JobType.INTERNSHIP)).toBe(expected);
    });

    it('matches nothing for a job type the board cannot express', () => {
      expect(matchesJobType(offer(), JobType.TEMPORARY)).toBe(false);
      expect(matchesJobType(offer(), JobType.PERMANENT)).toBe(false);
    });
  });

  describe('orderDivisionsByHints', () => {
    it.each([
      ['handlowiec', ['sales', 'it', 'marketing', 'logistics', 'finances', 'engineering', 'other', 'hr']],
      ['Księgowa', ['finances', 'it', 'sales', 'marketing', 'logistics', 'engineering', 'other', 'hr']],
      ['java', [...SOLIDJOBS_DIVISIONS_ALL]],
      ['HR Business Partner', ['hr', 'it', 'sales', 'marketing', 'logistics', 'finances', 'engineering', 'other']],
      ['asp.net', [...SOLIDJOBS_DIVISIONS_ALL]],
      ['java sales', [...SOLIDJOBS_DIVISIONS_ALL]],
      ['', [...SOLIDJOBS_DIVISIONS_ALL]],
    ])('%j', (term, expected) => {
      expect(orderDivisionsByHints(SOLIDJOBS_DIVISIONS_ALL, term)).toEqual(expected);
    });

    it('matches a stem only at the start of a word', () => {
      // "chrome" contains "hr"; "academy" contains "cad".
      expect(orderDivisionsByHints(SOLIDJOBS_DIVISIONS_ALL, 'chrome academy')).toEqual([
        ...SOLIDJOBS_DIVISIONS_ALL,
      ]);
    });

    it('keeps every division eligible', () => {
      expect(orderDivisionsByHints(SOLIDJOBS_DIVISIONS_ALL, 'magazynier').sort()).toEqual(
        [...SOLIDJOBS_DIVISIONS_ALL].sort(),
      );
    });
  });

  it.each([
    ['B2BSales', 'B2B Sales'],
    ['CustomerSuccess', 'Customer Success'],
    ['OtherDeveloper', 'Other Developer'],
    ['TestAutomationEngineer', 'Test Automation Engineer'],
    ['Developer', 'Developer'],
    ['', null],
    [null, null],
  ])('humaniseCode(%j) → %j', (code, expected) => {
    expect(humaniseCode(code as string | null)).toBe(expected);
  });

  it('recognises country-level location labels', () => {
    expect(isCountryLevelLabel('Cała Polska')).toBe(true);
    expect(isCountryLevelLabel('Zdalnie')).toBe(true);
    expect(isCountryLevelLabel('Warszawa')).toBe(false);
  });

  it('reads the posting instant from validFrom, then updatedAt', () => {
    expect(postedMs(offer({ validFrom: '2026-09-24T15:53:51.3998022+02:00' }))).toBe(
      Date.parse('2026-09-24T13:53:51.399Z'),
    );
    expect(postedMs(offer({ validFrom: '', updatedAt: '2026-09-24T12:00:00+02:00' }))).toBe(
      Date.parse('2026-09-24T10:00:00Z'),
    );
    expect(postedMs(offer({ validFrom: 'not a date' }))).toBeNull();
    expect(postedMs(offer())).toBeNull();
  });

  it('requires a key, a title and a URL to map an offer', () => {
    expect(isMappable(offer())).toBe(true);
    expect(isMappable(offer({ title: '' }))).toBe(false);
    expect(isMappable(null)).toBe(false);
  });

  describe('buildSolidJobsFilter', () => {
    const now = Date.parse('2026-09-24T18:00:00+02:00');

    it('returns null when nothing filters (the DTO defaults do not)', () => {
      expect(buildSolidJobsFilter({ isRemote: false })).toBeNull();
      expect(buildSolidJobsFilter({ searchTerm: '  ', location: 'Poland' })).toBeNull();
    });

    it('combines every active filter', () => {
      const filter = buildSolidJobsFilter(
        { searchTerm: 'java', location: 'Warsaw', isRemote: true, jobType: JobType.FULL_TIME, hoursOld: 24 },
        { nowMs: now },
      )!;
      expect(filter.active).toEqual(['searchTerm', 'location', 'isRemote', 'jobType', 'hoursOld']);
      expect(filter.cutoffMs).toBe(now - 24 * 3_600_000);
      const fresh = offer({ isRemote: true, validFrom: '2026-09-24T10:00:00+02:00' });
      expect(filter.matches(fresh)).toBe(true);
      expect(filter.matches({ ...fresh, isRemote: false })).toBe(false);
      expect(filter.matches({ ...fresh, validFrom: '2026-09-20T10:00:00+02:00' })).toBe(false);
      // An undated offer stays in the window.
      expect(filter.matches({ ...fresh, validFrom: undefined })).toBe(true);
    });

    it('drops the input filters but keeps searchTerm when inputFilters is false', () => {
      const filter = buildSolidJobsFilter(
        { searchTerm: 'java', location: 'Berlin', isRemote: true, hoursOld: 1 },
        { inputFilters: false, nowMs: now },
      )!;
      expect(filter.active).toEqual(['searchTerm']);
      expect(filter.cutoffMs).toBeNull();
      expect(filter.matches(offer())).toBe(true);
    });

    it('uses the whole-phrase matcher in phrase mode', () => {
      const filter = buildSolidJobsFilter({ searchTerm: 'Java Acme' }, { searchMode: 'phrase' })!;
      expect(filter.active).toEqual(['searchTerm(phrase)']);
      expect(filter.matches(offer())).toBe(false);
      expect(buildSolidJobsFilter({ searchTerm: 'programista java' }, { searchMode: 'phrase' })!.matches(offer())).toBe(
        true,
      );
    });
  });
});
