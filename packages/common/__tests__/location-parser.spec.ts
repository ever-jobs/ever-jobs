import { parseLocationList, parseLocationText } from '../src';

describe('parseLocationText', () => {
  it('splits a plain US city and state label', () => {
    const parsed = parseLocationText('  Atlanta,   GA  ');

    expect(parsed).toMatchObject({
      location: { city: 'Atlanta', state: 'GA' },
      remoteMentioned: false,
      workFromHomeType: null,
    });
  });

  it('normalizes lowercase postal codes', () => {
    expect(parseLocationText('Atlanta, ga').location).toMatchObject({
      city: 'Atlanta',
      state: 'GA',
    });
  });

  it('accepts US territories and military postal regions', () => {
    expect(parseLocationText('San Juan, PR').location).toMatchObject({
      city: 'San Juan',
      state: 'PR',
    });
    expect(parseLocationText('APO, AE').location).toMatchObject({
      city: 'APO',
      state: 'AE',
    });
  });

  it.each([
    ['Atlanta, GA (Hybrid)', false, 'Hybrid'],
    ['(REMOTE) Atlanta, ga', true, 'Remote'],
    ['Atlanta, GA (hybrid and/or REMOTE)', true, 'Hybrid or Remote'],
    ['hybrid / Atlanta, GA', false, 'Hybrid'],
    ['(hYbRiD) / Atlanta, GA', false, 'Hybrid'],
    ['Atlanta, GA / remote', true, 'Remote'],
    ['REMOTE / Atlanta, GA / HYBRID', true, 'Hybrid or Remote'],
  ] as const)(
    'extracts flexible workplace qualifiers from %s',
    (raw, remoteMentioned, workFromHomeType) => {
      expect(parseLocationText(raw)).toMatchObject({
        location: { city: 'Atlanta', state: 'GA' },
        remoteMentioned,
        workFromHomeType,
      });
    },
  );

  it('preserves unrecognized and unsafe labels without losing data', () => {
    expect(parseLocationText('Atlanta, GA (Headquarters)').location).toMatchObject({
      city: 'Atlanta, GA (Headquarters)',
    });
    expect(parseLocationText('Toronto, ON').location).toMatchObject({
      city: 'Toronto, ON',
    });
    expect(parseLocationText('Atlanta / Savannah, GA').location).toMatchObject({
      city: 'Atlanta / Savannah, GA',
    });
  });

  it('splits a remote-qualified location and retains its workplace meaning', () => {
    const parsed = parseLocationText('Remote / Atlanta, GA');

    expect(parsed.location).toMatchObject({ city: 'Atlanta', state: 'GA' });
    expect(parsed.remoteMentioned).toBe(true);
    expect(parsed.workFromHomeType).toBe('Remote');
  });

  it('returns no location for empty input', () => {
    expect(parseLocationText('   ')).toEqual({
      location: null,
      remoteMentioned: false,
      workFromHomeType: null,
    });
    expect(parseLocationText(null)).toEqual({
      location: null,
      remoteMentioned: false,
      workFromHomeType: null,
    });
  });
});

describe('parseLocationList', () => {
  it('deduplicates equivalent US city/state/country labels and preserves remote signal', () => {
    const parsed = parseLocationList([
      'Mountain View, CA',
      'Mountain View, California, United States',
      'Seattle, WA',
      'Seattle, WA, United States',
      'Remote',
      'United States',
    ]);

    expect(parsed.labels).toEqual(['Mountain View, CA', 'Seattle, WA']);
    expect(parsed.locations).toHaveLength(2);
    expect(parsed.locations[0]).toMatchObject({
      city: 'Mountain View',
      state: 'CA',
    });
    expect(parsed.locations[1]).toMatchObject({
      city: 'Seattle',
      state: 'WA',
    });
    expect(parsed.location).toMatchObject({
      city: 'Mountain View, CA; Seattle, WA',
      country: 'United States',
    });
    expect(parsed.remoteMentioned).toBe(true);
    expect(parsed.workFromHomeType).toBe('Remote');
  });

  it('suppresses broad country-only labels when concrete locations exist', () => {
    const parsed = parseLocationList(['United States', 'Austin, TX']);

    expect(parsed.labels).toEqual(['Austin, TX']);
    expect(parsed.location).toMatchObject({
      city: 'Austin',
      state: 'TX',
      country: 'United States',
    });
  });

  it('collapses a bare city when a structured city/state form is present', () => {
    const parsed = parseLocationList([
      'Los Angeles',
      'Los Angeles, California, USA',
    ]);

    expect(parsed.labels).toEqual(['Los Angeles, CA']);
    expect(parsed.location).toMatchObject({
      city: 'Los Angeles',
      state: 'CA',
      country: 'United States',
    });
  });

  it('keeps remote-only labels visible when there are no concrete locations', () => {
    const parsed = parseLocationList(['Remote', 'United States']);

    expect(parsed.labels).toEqual([]);
    expect(parsed.location).toMatchObject({
      city: 'Remote',
      country: 'United States',
    });
    expect(parsed.remoteMentioned).toBe(true);
    expect(parsed.workFromHomeType).toBe('Remote');
  });

  it('preserves unsafe labels without losing source text', () => {
    const parsed = parseLocationList(['Toronto, ON', 'Atlanta / Savannah, GA']);

    expect(parsed.labels).toEqual(['Toronto, ON', 'Atlanta / Savannah, GA']);
    expect(parsed.location).toMatchObject({
      city: 'Toronto, ON; Atlanta / Savannah, GA',
    });
  });
});

describe('allowBareStateProvince opt-in', () => {
  it('is OFF by default: a bare US state name/code stays in the city field', () => {
    expect(parseLocationText('Virginia').location).toMatchObject({ city: 'Virginia' });
    expect(parseLocationText('Virginia').location?.state).toBeUndefined();
    expect(parseLocationText('VA').location).toMatchObject({ city: 'VA' });
    expect(parseLocationList(['Virginia']).location).toMatchObject({ city: 'Virginia' });
  });

  it('classifies a bare US state name as a state-only location when enabled', () => {
    const parsed = parseLocationText('Virginia', { allowBareStateProvince: true });
    expect(parsed.location).toMatchObject({ state: 'VA' });
    expect(parsed.location?.city).toBeUndefined();
    expect(parsed.location?.displayLocation()).toBe('VA');
  });

  it('classifies a bare US state code (any case) as a state-only location when enabled', () => {
    expect(
      parseLocationText('va', { allowBareStateProvince: true }).location,
    ).toMatchObject({ state: 'VA' });
    expect(
      parseLocationText('  Rhode Island  ', { allowBareStateProvince: true })
        .location,
    ).toMatchObject({ state: 'RI' });
    expect(
      parseLocationList(['Virginia'], { allowBareStateProvince: true }).location,
    ).toMatchObject({ state: 'VA' });
  });

  it('leaves a City, ST pair unchanged even when enabled (no regression)', () => {
    expect(
      parseLocationText('Richmond, VA', { allowBareStateProvince: true }).location,
    ).toMatchObject({ city: 'Richmond', state: 'VA' });
  });

  it('does not promote a non-state token or a comma-bearing label when enabled', () => {
    // Not a US state → stays a city.
    expect(
      parseLocationText('Springfield', { allowBareStateProvince: true }).location,
    ).toMatchObject({ city: 'Springfield' });
    // Canadian province is out of scope for the US-only map → stays a city.
    expect(
      parseLocationText('Ontario', { allowBareStateProvince: true }).location,
    ).toMatchObject({ city: 'Ontario' });
    // A comma-bearing unsafe label is not a bare token → unchanged.
    expect(
      parseLocationText('Atlanta / Savannah, GA', {
        allowBareStateProvince: true,
      }).location,
    ).toMatchObject({ city: 'Atlanta / Savannah, GA' });
  });
});
