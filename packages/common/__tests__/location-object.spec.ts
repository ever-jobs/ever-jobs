import { toLocationDto, toLocationDtos } from '../src/utils/location-object';

describe('toLocationDtos — input shapes', () => {
  it('maps a flat object', () => {
    const out = toLocationDtos({ city: 'Berlin', state: 'BE', country: 'DE' });
    expect(out).toHaveLength(1);
    expect(out[0].city).toBe('Berlin');
    expect(out[0].state).toBe('BE');
    expect(out[0].country).toBe('DE');
  });

  it('maps an array of objects', () => {
    const out = toLocationDtos([{ city: 'Paris' }, { city: 'Lyon' }]);
    expect(out.map((l) => l.city)).toEqual(['Paris', 'Lyon']);
  });

  it('parses a direct string via parseLocationList', () => {
    const out = toLocationDtos('Austin, TX');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].city).toBe('Austin');
    expect(out[0].state).toBe('TX');
  });

  it('skips unusable entries and keeps source order', () => {
    const out = toLocationDtos([null, {}, { city: 'Berlin' }, { city: 'Paris' }]);
    expect(out.map((l) => l.city)).toEqual(['Berlin', 'Paris']);
  });

  it('toLocationDto returns the first usable result or null', () => {
    expect(toLocationDto([null, {}, { city: 'Berlin' }])?.city).toBe('Berlin');
    expect(toLocationDto([null, {}])).toBeNull();
    expect(toLocationDto(undefined)).toBeNull();
  });
});

describe('toLocationDtos — selection (opts.in)', () => {
  it('maps only the selected path, never the whole posting', () => {
    const posting = {
      title: 'Engineer',
      location: { city: 'Paris', office: { country: 'US' } },
    };
    const out = toLocationDtos(posting, { in: 'location' });
    expect(out).toHaveLength(1);
    // siblings under the selection do not merge geography
    expect(out[0].country).toBeNull();
  });

  it('ordered fallback paths: first yielding a usable location wins', () => {
    const posting = { PostingLocations: [{ city: 'Denver', state: 'CO' }] };
    const out = toLocationDtos(posting, {
      in: ['postingLocations', 'PostingLocations'],
    });
    expect(out).toHaveLength(1);
    expect(out[0].city).toBe('Denver');
  });

  it('returns [] when every selector fails', () => {
    expect(toLocationDtos({ city: 'Paris' }, { in: 'loc.address' })).toEqual([]);
  });

  it('never maps the whole posting as fallback', () => {
    const posting = { city: 'Paris', title: 'x' };
    expect(toLocationDtos(posting, { in: 'missing' })).toEqual([]);
  });
});

describe('toLocationDtos — address descent', () => {
  it('auto-descends into address/postalAddress to fill missing slots', () => {
    const out = toLocationDtos({
      name: 'HQ',
      address: { city: 'Austin', state: 'TX', country: 'US', streetAddress: '1 Main St' },
    });
    expect(out[0].name).toBe('HQ');
    expect(out[0].city).toBe('Austin');
    expect(out[0].streetAddress).toBe('1 Main St');
  });

  it('root slots win over address values', () => {
    const out = toLocationDtos({
      city: 'Boston',
      address: { city: 'Austin', state: 'TX' },
    });
    expect(out[0].city).toBe('Boston');
    expect(out[0].state).toBe('TX');
  });

  it('expands address arrays into separate locations', () => {
    const out = toLocationDtos({
      name: 'Offices',
      address: [{ city: 'Austin' }, { city: 'Denver' }],
    });
    expect(out.map((l) => l.city).sort()).toEqual(['Austin', 'Denver']);
  });

  it('a string address supplies streetAddress only', () => {
    const out = toLocationDtos({ city: 'X', address: '10 Downing St' });
    expect(out[0].streetAddress).toBe('10 Downing St');
    expect(out[0].city).toBe('X');
  });
});

describe('toLocationDtos — agreement and conflicts', () => {
  it('identical copies consume together', () => {
    const out = toLocationDtos({ city: 'Paris', City: 'Paris' });
    expect(out[0].city).toBe('Paris');
    expect(out[0].extras?.City).toBeUndefined();
  });

  it('case-variant conflict leaves slot unset without prefer', () => {
    const out = toLocationDtos({ city: 'Paris', City: 'Lyon', country: 'FR' });
    expect(out[0].city).toBeNull();
    expect(out[0].extras?.City).toBe('Lyon');
  });

  it('explicit prefer resolves the conflict', () => {
    const out = toLocationDtos(
      { city: 'Paris', City: 'Lyon', country: 'FR' },
      { prefer: { city: 'City' } },
    );
    expect(out[0].city).toBe('Lyon');
  });

  it('scalar canonical field wins over suffixed aliases', () => {
    const out = toLocationDtos({ city: 'Paris', cityName: 'Lyon' });
    expect(out[0].city).toBe('Paris');
  });

  it('two non-canonical aliases in conflict leave the slot unset', () => {
    const out = toLocationDtos({ town: 'Paris', cityName: 'Lyon', country: 'FR' });
    expect(out[0].city).toBeNull();
    expect(out[0].extras?.town).toBe('Paris');
  });

  it('object country picks the recognized full name, keeps residual extras', () => {
    const out = toLocationDtos({
      country: { alpha2Code: 'DE', name: 'Germany', id: '123' },
    });
    expect(out[0].country).toBe('Germany');
    expect((out[0].extras?.country as Record<string, unknown>)?.id).toBe('123');
  });

  it('state code/name agree without minting a US country', () => {
    const out = toLocationDtos({ stateCode: 'CA', stateName: 'California' });
    expect(out[0].state).toBe('California');
    expect(out[0].country).toBeNull();
  });

  it('conflicting object country leaves slot unset', () => {
    const out = toLocationDtos({
      country: { alpha2Code: 'DE', name: 'France' },
      city: 'Berlin',
    });
    expect(out[0].country).toBeNull();
    expect(out[0].city).toBe('Berlin');
  });
});

describe('toLocationDtos — coercion', () => {
  it('numeric postal zero survives', () => {
    const out = toLocationDtos({ postalCode: 0 });
    expect(out[0].postalCode).toBe('0');
  });

  it('booleans never become geography', () => {
    const out = toLocationDtos({ city: true, country: 'DE' });
    expect(out[0].city).toBeNull();
    expect(out[0].extras?.city).toBe(true);
  });

  it('whitespace-only strings are no value', () => {
    const out = toLocationDtos({ city: '  ', country: 'DE' });
    expect(out[0].city).toBeNull();
  });

  it('non-string/non-finite values land in extras', () => {
    const out = toLocationDtos({ city: { weird: 1 }, country: 'DE' });
    expect(out[0].city).toBeNull();
    expect(out[0].extras?.city).toBeDefined();
  });
});

describe('toLocationDtos — ambiguous keys route to extras', () => {
  it('officeName/siteName/descriptor/label/title have no default slot', () => {
    const out = toLocationDtos({
      officeName: 'The Hive',
      descriptor: 'Berlin, Germany',
      label: 'X',
      city: 'Berlin',
    });
    expect(out[0].name).toBeNull();
    expect(out[0].text).toBeNull();
    expect(out[0].extras?.officeName).toBe('The Hive');
    expect(out[0].extras?.descriptor).toBe('Berlin, Germany');
  });

  it('locationName maps to text (observed geo label)', () => {
    const out = toLocationDtos({ locationName: 'Austin, TX' });
    expect(out[0].text).toBe('Austin, TX');
  });

  it('nameKeys/textKeys assign ambiguous keys explicitly', () => {
    const out = toLocationDtos(
      { descriptor: 'Downtown Office' },
      { nameKeys: ['descriptor'] },
    );
    expect(out[0].name).toBe('Downtown Office');
    expect(out[0].extras?.descriptor).toBeUndefined();
  });

  it('assigning one path to two slots throws', () => {
    expect(() =>
      toLocationDtos({ name: 'x' }, { nameKeys: ['label'], textKeys: ['label'] }),
    ).toThrow();
  });
});

describe('toLocationDtos — extras', () => {
  it('carry-all default: unclaimed fields land in extras', () => {
    const out = toLocationDtos({
      city: 'Berlin',
      coordinates: { lat: 52, lng: 13 },
      locationId: 'loc-9',
    });
    expect((out[0].extras?.coordinates as { lat: number }).lat).toBe(52);
    expect(out[0].extras?.locationId).toBe('loc-9');
  });

  it('keep:[] carries nothing', () => {
    const out = toLocationDtos({ city: 'X', junk: 1 }, { keep: [] });
    expect(out[0].extras ?? null).toBeNull();
  });

  it('keep whitelist filters residuals; drop wins over keep', () => {
    const out = toLocationDtos(
      { city: 'X', a: 1, b: 2, 'c.deep': undefined },
      { keep: ['a', 'b'], drop: ['b'] },
    );
    expect(out[0].extras?.a).toBe(1);
    expect(out[0].extras?.b).toBeUndefined();
  });

  it('extras alone never create a location', () => {
    expect(toLocationDtos({ locationId: 'x', locationType: 'y' })).toEqual([]);
  });

  it('incoming extras flatten, raw keys win collisions', () => {
    const out = toLocationDtos({
      city: 'X',
      extras: { locationId: 'old', other: 1 },
      locationId: 'new',
    });
    expect(out[0].extras?.locationId).toBe('new');
    expect(out[0].extras?.other).toBe(1);
    expect(out[0].extras?.extras).toBeUndefined();
  });

  it('extras survive a JSON round-trip', () => {
    const dto = toLocationDto({ city: 'X', coordinates: { lat: 1 } });
    const revived = JSON.parse(JSON.stringify(dto));
    expect(revived.extras.coordinates.lat).toBe(1);
  });
});

describe('toLocationDtos — dedup', () => {
  it('collapses exact-duplicate mapped DTOs', () => {
    const out = toLocationDtos([{ city: 'Berlin' }, { city: 'Berlin' }]);
    expect(out).toHaveLength(1);
  });

  it('keeps same-field sites with distinct extras separate', () => {
    const out = toLocationDtos([
      { city: 'Berlin', locationId: '1' },
      { city: 'Berlin', locationId: '2' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('toLocationDtos — street/postal-only results', () => {
  it('street-only and postal-only entries survive', () => {
    const out = toLocationDtos([
      { streetAddress: '1 Main St' },
      { postalCode: '78701' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('toLocationDtos — parseTextFallback', () => {
  it('parses selected text into missing slots without overwriting', () => {
    const out = toLocationDtos(
      { text: 'Austin, TX', city: 'Austin' },
      { parseTextFallback: true },
    );
    expect(out[0].city).toBe('Austin');
    expect(out[0].state).toBe('TX');
  });

  it('rejects all inferred fields on any conflict', () => {
    const out = toLocationDtos(
      { text: 'Austin, TX', state: 'CA' },
      { parseTextFallback: true },
    );
    expect(out[0].state).toBe('CA');
    expect(out[0].city).toBeNull();
  });
});
