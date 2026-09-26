import {
  COUNTRY_CONFIG,
  Country,
  countryFromString,
  getCountryDisplayName,
  getIndeedDomain,
} from '@ever-jobs/models';
import {
  ISO_ALPHA2_TO_ALPHA3,
  ISO_ALPHA3_TO_ALPHA2,
  isoAlpha2FromAlpha3,
  isoAlpha3FromAlpha2,
  regionNameFromCode,
} from '../src';

describe('ISO 3166-1 table (Spec 1699)', () => {
  const alpha2Codes = Object.keys(ISO_ALPHA2_TO_ALPHA3);

  it('holds the 249 official codes plus Kosovo', () => {
    expect(alpha2Codes).toHaveLength(250);
    expect(ISO_ALPHA2_TO_ALPHA3.XK).toBe('XKX');
    for (const code of alpha2Codes) expect(code).toMatch(/^[A-Z]{2}$/);
    for (const code of Object.values(ISO_ALPHA2_TO_ALPHA3)) {
      expect(code).toMatch(/^[A-Z]{3}$/);
    }
  });

  it('is a bijection: alpha-3 values are unique and the maps invert', () => {
    expect(new Set(Object.values(ISO_ALPHA2_TO_ALPHA3)).size).toBe(250);
    expect(Object.keys(ISO_ALPHA3_TO_ALPHA2)).toHaveLength(250);
    for (const [alpha2, alpha3] of Object.entries(ISO_ALPHA2_TO_ALPHA3)) {
      expect(ISO_ALPHA3_TO_ALPHA2[alpha3]).toBe(alpha2);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ISO_ALPHA2_TO_ALPHA3)).toBe(true);
    expect(Object.isFrozen(ISO_ALPHA3_TO_ALPHA2)).toBe(true);
  });

  // a typo in the table (a code CLDR does not know) fails here
  it.each(alpha2Codes)('%s resolves to a CLDR region name', (code) => {
    expect(regionNameFromCode(code)).not.toBeNull();
  });

  it('holds no pseudo, reserved or retired region', () => {
    for (const code of [
      'EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'AC', 'CP', 'DG', 'EA', 'IC',
      'TA', 'UK', 'SU', 'YU', 'CS', 'AN', 'DD', 'FX', 'ZR', 'TP', 'BU',
    ]) {
      expect(ISO_ALPHA2_TO_ALPHA3[code]).toBeUndefined();
    }
  });

  it('pins the codes the parser and boards rely on', () => {
    expect(ISO_ALPHA2_TO_ALPHA3).toMatchObject({
      LK: 'LKA',
      SI: 'SVN',
      SL: 'SLE',
      GB: 'GBR',
      US: 'USA',
      AE: 'ARE',
      CZ: 'CZE',
      HK: 'HKG',
      TR: 'TUR',
      KR: 'KOR',
      CD: 'COD',
      CG: 'COG',
      MM: 'MMR',
      GE: 'GEO',
    });
  });

  it('looks codes up case-insensitively, null on a miss', () => {
    expect(isoAlpha3FromAlpha2('lk')).toBe('LKA');
    expect(isoAlpha3FromAlpha2(' SI ')).toBe('SVN');
    expect(isoAlpha3FromAlpha2('EU')).toBeNull();
    expect(isoAlpha3FromAlpha2('toString')).toBeNull();
    expect(isoAlpha3FromAlpha2(undefined)).toBeNull();
    expect(isoAlpha2FromAlpha3('lka')).toBe('LK');
    expect(isoAlpha2FromAlpha3('XKX')).toBe('XK');
    expect(isoAlpha2FromAlpha3('UAE')).toBeNull();
    expect(isoAlpha2FromAlpha3('')).toBeNull();
  });
});

describe('COUNTRY_CONFIG codes (Spec 1699)', () => {
  /** Entries whose Indeed host is not a country market. */
  const NON_MARKET = new Set<Country>([Country.US_CANADA, Country.WORLDWIDE]);
  /** CLDR spells these differently from every configured name. */
  const CLDR_NAME_DIFFERS: Partial<Record<Country, string>> = {
    [Country.HONGKONG]: 'Hong Kong SAR China',
  };
  const fold = (value: string) =>
    value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
  const countries = (Object.keys(COUNTRY_CONFIG) as Country[]).filter(
    (country) => !NON_MARKET.has(country),
  );

  // Slovenia was configured as 'sl' — Sierra Leone — and went red here
  it.each(countries)('%s: its apiCountryCode names the same country', (country) => {
    const { apiCountryCode } = getIndeedDomain(country);
    const cldr = regionNameFromCode(apiCountryCode);
    expect(cldr).not.toBeNull();
    const expected = CLDR_NAME_DIFFERS[country];
    if (expected) {
      expect(cldr).toBe(expected);
    } else {
      const names = COUNTRY_CONFIG[country].names.split(',').map(fold);
      expect(names).toContain(fold(cldr as string));
    }
  });

  it('keeps every apiCountryCode unique and in the ISO table', () => {
    const codes = countries.map((c) => getIndeedDomain(c).apiCountryCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      // an ISO alpha-2 ('GB' for the UK entry, 'MY' for Malaysia)
      expect(ISO_ALPHA2_TO_ALPHA3[code]).toBeDefined();
    }
  });

  it('sends Slovenia as SI, never SL (Sierra Leone)', () => {
    expect(getIndeedDomain(Country.SLOVENIA).apiCountryCode).toBe('SI');
    expect(regionNameFromCode(getIndeedDomain(Country.SLOVENIA).apiCountryCode)).toBe(
      'Slovenia',
    );
  });

  it('accepts Sri Lanka as an input country', () => {
    expect(countryFromString('Sri Lanka')).toBe(Country.SRILANKA);
    expect(countryFromString('srilanka')).toBe(Country.SRILANKA);
    expect(countryFromString(' SRI LANKA ')).toBe(Country.SRILANKA);
    expect(getIndeedDomain(Country.SRILANKA).apiCountryCode).toBe('LK');
    expect(regionNameFromCode('LK')).toBe('Sri Lanka');
  });

  it('capitalises every word of a display name, keeping USA / UK', () => {
    expect(getCountryDisplayName(Country.SRILANKA)).toBe('Sri Lanka');
    expect(getCountryDisplayName(Country.COSTARICA)).toBe('Costa Rica');
    expect(getCountryDisplayName(Country.UNITEDARABEMIRATES)).toBe(
      'United Arab Emirates',
    );
    expect(getCountryDisplayName(Country.GERMANY)).toBe('Germany');
    expect(getCountryDisplayName(Country.TURKEY)).toBe('Türkiye');
    expect(getCountryDisplayName(Country.USA)).toBe('USA');
    expect(getCountryDisplayName(Country.UK)).toBe('UK');
  });
});
