import { DEFAULT_MAX_SEARCH_LOCATIONS, HARD_MAX_SEARCH_LOCATIONS } from '@ever-jobs/models';
import {
  clampMaxLocations,
  normalizeSearchLocation,
  resolveSearchLocations,
  searchLocationsCacheKey,
  searchLocationsOrderedCacheKey,
} from '../src/utils/search-locations';

/** Spec 1700 — multi-location search input resolution. */
describe('normalizeSearchLocation', () => {
  it('trims, collapses inner whitespace and NFC-normalises', () => {
    expect(normalizeSearchLocation('  Austin,   TX ')).toBe('Austin, TX');
    // "é" as e + combining acute becomes the single precomposed code point.
    expect(normalizeSearchLocation('Montréal')).toBe('Montréal');
    expect(normalizeSearchLocation('New\tYork,\nNY')).toBe('New York, NY');
  });

  it('returns an empty string for non-strings', () => {
    for (const raw of [undefined, null, 42, {}, ['x']]) {
      expect(normalizeSearchLocation(raw)).toBe('');
    }
  });
});

describe('resolveSearchLocations', () => {
  it('returns nothing for absent, empty or blank input', () => {
    expect(resolveSearchLocations({})).toEqual({ locations: [], overCap: [] });
    expect(resolveSearchLocations({ locations: [] })).toEqual({ locations: [], overCap: [] });
    expect(resolveSearchLocations({ location: '' })).toEqual({ locations: [], overCap: [] });
    expect(resolveSearchLocations({ location: '   ', locations: ['  '] })).toEqual({ locations: [], overCap: [] });
  });

  it('uses `location` alone, normalised', () => {
    expect(resolveSearchLocations({ location: '  Austin,   TX ' }).locations).toEqual(['Austin, TX']);
  });

  it('puts `location` first, then `locations` in caller order', () => {
    expect(
      resolveSearchLocations({ location: 'NYC', locations: ['Chicago', 'Boston'] }).locations,
    ).toEqual(['NYC', 'Chicago', 'Boston']);
  });

  it('collapses case and whitespace duplicates, keeping the first spelling', () => {
    expect(
      resolveSearchLocations({ locations: ['New York, NY', 'new york,  ny '] }).locations,
    ).toEqual(['New York, NY']);
    expect(
      resolveSearchLocations({ location: 'Chicago, IL', locations: ['chicago, il', 'Boston'] }).locations,
    ).toEqual(['Chicago, IL', 'Boston']);
  });

  it('keeps diacritic variants distinct', () => {
    expect(resolveSearchLocations({ locations: ['São Paulo', 'Sao Paulo'] }).locations).toEqual([
      'São Paulo',
      'Sao Paulo',
    ]);
  });

  it('drops blanks and non-strings', () => {
    expect(
      resolveSearchLocations({ locations: ['', '   ', 42, null, 'Berlin'] as unknown[] }).locations,
    ).toEqual(['Berlin']);
  });

  it('ignores a non-array `locations`', () => {
    expect(resolveSearchLocations({ location: 'Berlin', locations: 'Paris' }).locations).toEqual(['Berlin']);
  });

  it('caps at maxLocations and reports the rest in order', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `City ${i + 1}`);
    const out = resolveSearchLocations({ locations: twelve }, 10);
    expect(out.locations).toEqual(twelve.slice(0, 10));
    expect(out.overCap).toEqual(['City 11', 'City 12']);
  });

  it('counts only unique entries against the cap', () => {
    const out = resolveSearchLocations({ locations: ['A', 'a', 'B', 'b', 'C'] }, 2);
    expect(out).toEqual({ locations: ['A', 'B'], overCap: ['C'] });
  });

  it('clamps a bad maxLocations to the default', () => {
    const many = Array.from({ length: 20 }, (_, i) => `C${i}`);
    expect(resolveSearchLocations({ locations: many }, Number.POSITIVE_INFINITY).locations).toHaveLength(
      DEFAULT_MAX_SEARCH_LOCATIONS,
    );
  });
});

describe('searchLocationsCacheKey', () => {
  it('is order- and case-insensitive', () => {
    expect(searchLocationsCacheKey(['B', 'a'])).toEqual(searchLocationsCacheKey(['A', 'b']));
    expect(searchLocationsCacheKey(['Chicago, IL', 'new york, ny'])).toEqual(
      searchLocationsCacheKey(['New York, NY', 'Chicago, IL']),
    );
  });

  it('keeps diacritics in the key', () => {
    expect(searchLocationsCacheKey(['São Paulo'])).not.toEqual(searchLocationsCacheKey(['Sao Paulo']));
  });
});

describe('searchLocationsOrderedCacheKey', () => {
  it('keeps the caller order', () => {
    expect(searchLocationsOrderedCacheKey(['B', 'a'])).toEqual(['b', 'a']);
    expect(searchLocationsOrderedCacheKey(['B', 'a'])).not.toEqual(searchLocationsOrderedCacheKey(['a', 'B']));
  });

  it('normalises case and whitespace per entry and drops blanks', () => {
    expect(searchLocationsOrderedCacheKey(['  New   York, NY ', '', '   ', 'CHICAGO, IL'])).toEqual([
      'new york, ny',
      'chicago, il',
    ]);
  });

  it('drops duplicates keeping the first occurrence, like resolveSearchLocations', () => {
    const raw = ['Chicago, IL', 'new york, ny', 'CHICAGO,  IL', 'New York, NY', 'Austin, TX'];
    expect(searchLocationsOrderedCacheKey(raw)).toEqual(['chicago, il', 'new york, ny', 'austin, tx']);
    const resolved = resolveSearchLocations({ locations: raw }).locations;
    expect(searchLocationsOrderedCacheKey(resolved)).toEqual(searchLocationsOrderedCacheKey(raw));
    expect(searchLocationsOrderedCacheKey(resolved)).toEqual(resolved.map((l) => l.toLocaleLowerCase('en')));
  });

  it('keeps diacritics in the key', () => {
    expect(searchLocationsOrderedCacheKey(['São Paulo'])).not.toEqual(searchLocationsOrderedCacheKey(['Sao Paulo']));
  });
});

describe('clampMaxLocations', () => {
  it.each([
    [Number.POSITIVE_INFINITY],
    [Number.NaN],
    [0],
    [-1],
    [1e9],
    [HARD_MAX_SEARCH_LOCATIONS + 1],
    ['abc'],
    [undefined],
    [null],
    [''],
  ])('falls back to the default for %p', (raw) => {
    expect(clampMaxLocations(raw)).toBe(DEFAULT_MAX_SEARCH_LOCATIONS);
  });

  it('honours in-range values, numeric strings included, and floors fractions', () => {
    expect(clampMaxLocations('5')).toBe(5);
    expect(clampMaxLocations(1)).toBe(1);
    expect(clampMaxLocations(HARD_MAX_SEARCH_LOCATIONS)).toBe(HARD_MAX_SEARCH_LOCATIONS);
    expect(clampMaxLocations(3.9)).toBe(3);
  });
});
