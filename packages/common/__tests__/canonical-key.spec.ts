import {
  CANONICAL_KEY_ENV,
  canonicalJobId,
  canonicalKey,
  parseLocationList,
  resetCanonicalKeyEnvCache,
  resetLocationParserEnvCache,
} from '@ever-jobs/common';

describe('canonicalKey (Spec 003 / T05)', () => {
  it('joins normalised triple with pipes', () => {
    const key = canonicalKey({
      company: 'Acme, Inc.',
      title: 'Sr. Software Engineer',
      location: 'Remote, US',
    });
    expect(key).toBe('acme|senior swe|remote');
  });

  it('returns the same key regardless of source-side cosmetic differences', () => {
    const a = canonicalKey({
      company: 'ACME Corporation',
      title: 'Senior Software Engineer (Remote)',
      location: 'Anywhere',
    });
    const b = canonicalKey({
      company: 'Acme, Inc.',
      title: 'Sr. SWE',
      location: 'Remote',
    });
    expect(a).toBe(b);
  });

  it('handles null/undefined inputs gracefully', () => {
    expect(canonicalKey({ company: null, title: null, location: null })).toBe('||');
    expect(canonicalKey({ company: undefined, title: undefined, location: undefined })).toBe('||');
  });

  it('returns DIFFERENT keys for different titles', () => {
    const a = canonicalKey({ company: 'Acme', title: 'Engineer', location: 'NYC' });
    const b = canonicalKey({ company: 'Acme', title: 'Manager', location: 'NYC' });
    expect(a).not.toBe(b);
  });
});

describe('canonicalJobId (Spec 003 / T05)', () => {
  it('produces a 64-char lower-case hex digest', () => {
    const id = canonicalJobId({ company: 'Acme', title: 'Engineer', location: 'NYC' });
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    const args = { company: 'Acme', title: 'Engineer', location: 'NYC' };
    expect(canonicalJobId(args)).toBe(canonicalJobId(args));
  });

  it('different inputs produce different ids', () => {
    expect(
      canonicalJobId({ company: 'Acme', title: 'Engineer', location: 'NYC' }),
    ).not.toBe(canonicalJobId({ company: 'Acme', title: 'Manager', location: 'NYC' }));
  });

  it('cosmetic-only differences collapse to the SAME id', () => {
    const a = canonicalJobId({
      company: 'ACME Corporation',
      title: 'Senior Software Engineer (Remote)',
      location: 'Anywhere',
    });
    const b = canonicalJobId({
      company: 'Acme, Inc.',
      title: 'Sr. SWE',
      location: 'Remote',
    });
    expect(a).toBe(b);
  });

  it('empty inputs still produce a valid hex id', () => {
    const id = canonicalJobId({ company: '', title: '', location: '' });
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('canonicalKey — locations[] site set (Spec 5123)', () => {
  it('derives the location component from locations[] triples, ignoring the flat string', () => {
    const a = canonicalKey({
      company: 'Acme',
      title: 'Engineer',
      location: 'Amsterdam; Austin, TX',
      locations: [
        { city: 'Amsterdam', country: 'NL' },
        { city: 'Austin', state: 'TX' },
      ],
    });
    const b = canonicalKey({
      company: 'Acme',
      title: 'Engineer',
      location: 'something else entirely',
      locations: [
        { city: 'Austin', state: 'Texas' },
        { city: 'Amsterdam', country: 'NL' },
      ],
    });
    expect(a).toBe(b);
  });

  it('is order-insensitive across the site set', () => {
    const forward = canonicalKey({
      company: 'Acme',
      title: 'Engineer',
      location: 'x',
      locations: [{ city: 'Denver', state: 'CO' }, { city: 'Tulsa', state: 'OK' }],
    });
    const reverse = canonicalKey({
      company: 'Acme',
      title: 'Engineer',
      location: 'x',
      locations: [{ city: 'Tulsa', state: 'OK' }, { city: 'Denver', state: 'CO' }],
    });
    expect(forward).toBe(reverse);
  });

  it('differs when the site set differs', () => {
    const one = canonicalKey({
      company: 'Acme',
      title: 'Engineer',
      location: 'x',
      locations: [{ city: 'Amsterdam', country: 'NL' }],
    });
    const two = canonicalKey({
      company: 'Acme',
      title: 'Engineer',
      location: 'x',
      locations: [
        { city: 'Amsterdam', country: 'NL' },
        { city: 'Austin', state: 'TX' },
      ],
    });
    expect(one).not.toBe(two);
  });

  it('falls back to the flat location string when locations[] yields no geography', () => {
    const withTextOnly = canonicalKey({
      company: 'Acme',
      title: 'Engineer',
      location: 'Remote',
      locations: [{}],
    });
    const noLocations = canonicalKey({
      company: 'Acme',
      title: 'Engineer',
      location: 'Remote',
    });
    expect(withTextOnly).toBe(noLocations);
  });
});

describe('canonicalKey — fork-sync hardening (Spec 1689)', () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of Object.values(CANONICAL_KEY_ENV)) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    resetCanonicalKeyEnvCache();
    resetLocationParserEnvCache();
  });
  afterEach(() => {
    for (const name of Object.values(CANONICAL_KEY_ENV)) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetCanonicalKeyEnvCache();
  });

  const base = { company: 'Acme', title: 'Engineer' };

  /** What a structured ATS (iCIMS, Jobvite, …) still emits for a remote job. */
  const structuredRemote = {
    ...base,
    location: 'Remote',
    locations: [{ city: 'Remote' }],
  };

  /**
   * A migrated plugin: raw label -> parseLocationList -> job fields.
   * `emitRemoteCity` false is the fork's parser output (no Remote city), the
   * harder case for the key; the remote-bucket block runs under both.
   */
  const migrated = (label: string, isRemote?: boolean, emitRemoteCity = false) => {
    const parsed = parseLocationList([label], { emitRemoteCity });
    return {
      ...base,
      location: parsed.location
        ? [parsed.location.city, parsed.location.state, parsed.location.country]
            .filter(Boolean)
            .join(', ')
        : '',
      locations: parsed.locations,
      isRemote: isRemote ?? parsed.remoteMentioned,
    };
  };

  describe.each([false, true])('remote bucket (parser emitRemoteCity=%s)', (emitRemoteCity) => {
    const m = (label: string, isRemote?: boolean) =>
      migrated(label, isRemote, emitRemoteCity);

    it('a migrated "Remote" keys like a structured { city: "Remote" }', () => {
      expect(canonicalKey(structuredRemote)).toBe('acme|engineer|remote');
      expect(canonicalKey(m('Remote'))).toBe(canonicalKey(structuredRemote));
      expect(canonicalJobId(m('Remote'))).toBe(canonicalJobId(structuredRemote));
    });

    it('"Remote - US" / "Remote, United States" / "United States (Remote)" / "Remote - Canada" stay in the remote bucket', () => {
      for (const label of [
        'Remote - US',
        'Remote, United States',
        'United States (Remote)',
        'Remote - Canada',
      ]) {
        expect([label, canonicalKey(m(label))]).toEqual([
          label,
          canonicalKey(structuredRemote),
        ]);
      }
    });

    it('reads the remote token from a site text even without isRemote', () => {
      // 'Remote, US' parses to { country, text: 'Remote, US' }
      expect(canonicalKey(m('Remote, US', false))).toBe(
        canonicalKey(structuredRemote),
      );
    });

    it('a concrete site wins over the remote flag', () => {
      const key = canonicalKey({
        ...base,
        location: 'Austin, TX',
        locations: [{ city: 'Austin', state: 'TX' }],
        isRemote: true,
      });
      expect(key).toBe('acme|engineer|austin texas');
      expect(
        canonicalKey({ ...base, location: 'Austin, TX', isRemote: true }),
      ).toBe('acme|engineer|austin texas');
    });

    it('a remote job with only a country keys to remote; a non-remote one keys to the country', () => {
      const countryOnly = {
        ...base,
        location: 'United States',
        locations: [{ country: 'United States' }],
      };
      expect(canonicalKey({ ...countryOnly, isRemote: true })).toBe(
        'acme|engineer|remote',
      );
      expect(canonicalKey(countryOnly)).toBe('acme|engineer|united states');
    });

    // Spec 5123 key: a parsed 'Remote' keyed to '' with the fork's parser
    // output, and to 'remote' via the flat label once the Remote city is back
    const bareRemoteKey = emitRemoteCity ? 'acme|engineer|remote' : 'acme|engineer|';

    it('remoteBucket:false restores the Spec 5123 key', () => {
      expect(canonicalKey(m('Remote'), { remoteBucket: false })).toBe(bareRemoteKey);
      expect(canonicalKey(m('Remote - US'), { remoteBucket: false })).toBe(
        'acme|engineer|united states',
      );
    });

    it('EVER_JOBS_CANONICAL_KEY_REMOTE_BUCKET=false sets that as the default', () => {
      process.env[CANONICAL_KEY_ENV.remoteBucket] = 'false';
      resetCanonicalKeyEnvCache();
      expect(canonicalKey(m('Remote'))).toBe(bareRemoteKey);
      expect(canonicalKey(m('Remote - US'), { remoteBucket: true })).toBe(
        'acme|engineer|remote',
      );
    });
  });

  describe('country normalisation', () => {
    const austin = (country: string) => ({
      ...base,
      location: 'x',
      locations: [{ city: 'Austin', state: 'TX', country }],
    });

    it('USA / US / United States / Country.USA produce one key', () => {
      const keys = new Set([
        canonicalKey(austin('US')),
        canonicalKey(austin('USA')),
        canonicalKey(austin('United States')),
        canonicalKey(austin('united states')),
        canonicalKey({ ...base, location: 'Austin, TX, USA' }),
        canonicalKey({ ...base, location: 'Austin, TX, US' }),
        canonicalKey({ ...base, location: 'Austin, TX, United States' }),
      ]);
      expect([...keys]).toEqual(['acme|engineer|austin texas united states']);
    });

    it('"Austin, TX, USA" parsed matches a structured { country: "US" }', () => {
      expect(canonicalKey(migrated('Austin, TX, USA'))).toBe(
        canonicalKey(austin('US')),
      );
      expect(canonicalJobId(migrated('Austin, TX, USA'))).toBe(
        canonicalJobId({
          ...base,
          location: 'Austin, TX, US',
          locations: [{ city: 'Austin', state: 'TX', country: 'US' }],
        }),
      );
    });

    it('normalises ISO alpha-2/3 and enum keys for non-US countries', () => {
      const uk = canonicalKey({
        ...base,
        location: 'x',
        locations: [{ city: 'London', country: 'GB' }],
      });
      expect(
        canonicalKey({ ...base, location: 'x', locations: [{ city: 'London', country: 'UK' }] }),
      ).toBe(uk);
      expect(
        canonicalKey({ ...base, location: 'x', locations: [{ city: 'London', country: 'GBR' }] }),
      ).toBe(uk);
      expect(canonicalKey({ ...base, location: 'London, United Kingdom' })).toBe(uk);
      expect(
        canonicalKey({
          ...base,
          location: 'x',
          locations: [{ city: 'Dubai', country: 'UNITEDARABEMIRATES' }],
        }),
      ).toBe(
        canonicalKey({ ...base, location: 'x', locations: [{ city: 'Dubai', country: 'AE' }] }),
      );
    });

    it('never reads a flat US-state tail as a country ("San Francisco, CA")', () => {
      expect(canonicalKey({ ...base, location: 'San Francisco, CA' })).toBe(
        'acme|engineer|san francisco california',
      );
    });

    it('normalizeCountry:false keeps countries verbatim (the pre-hardening key)', () => {
      expect(canonicalKey(austin('US'), { normalizeCountry: false })).not.toBe(
        canonicalKey(austin('USA'), { normalizeCountry: false }),
      );
      expect(
        canonicalKey({ ...base, location: 'New York, NY, USA' }, { normalizeCountry: false }),
      ).toBe('acme|engineer|new york new york usa');
    });

    it('EVER_JOBS_CANONICAL_KEY_NORMALIZE_COUNTRY=false sets that as the default', () => {
      process.env[CANONICAL_KEY_ENV.normalizeCountry] = 'false';
      resetCanonicalKeyEnvCache();
      expect(canonicalKey(austin('US'))).toBe('acme|engineer|austin texas us');
    });
  });
});
