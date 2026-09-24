import {
  DEFAULT_MAX_LOCATION_LABEL_LENGTH,
  LOCATION_PARSER_ENV,
  canonicalCountryName,
  findUsAddressSnippet,
  matchRemoteInGeo,
  normalizeCountryOnly,
  parseLocationList,
  parseLocationText,
  resetLocationParserEnvCache,
} from '../src';

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

  it('maps unrecognized subdivisions verbatim into state and site descriptors into name', () => {
    expect(
      parseLocationText('Atlanta, GA (Headquarters)').location,
    ).toMatchObject({ city: 'Atlanta', state: 'GA', name: 'Headquarters' });
    // 'ON' is not a US state or ISO country -> verbatim subdivision
    expect(parseLocationText('Toronto, ON').location).toMatchObject({
      city: 'Toronto',
      state: 'ON',
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

    expect(parsed.labels).toEqual([
      'Mountain View, CA, United States',
      'Seattle, WA, United States',
      'United States',
    ]);
    expect(parsed.locations).toHaveLength(3);
    expect(parsed.locations[0]).toMatchObject({
      city: 'Mountain View',
      state: 'CA',
      country: 'United States',
    });
    expect(parsed.locations[1]).toMatchObject({
      city: 'Seattle',
      state: 'WA',
      country: 'United States',
    });
    expect(parsed.locations[2]).toMatchObject({ country: 'United States' });
    expect(parsed.location).toMatchObject({
      city: 'Mountain View, California; Seattle, WA',
      country: 'United States',
    });
    expect(parsed.remoteMentioned).toBe(true);
    expect(parsed.workFromHomeType).toBe('Remote');
  });

  it('stamps the sole literal country on the merged view when nothing conflicts', () => {
    const parsed = parseLocationList(['United States', 'Austin, TX']);

    expect(parsed.labels).toEqual(['United States', 'Austin, TX']);
    expect(parsed.location).toMatchObject({
      city: 'Austin, TX',
      country: 'United States',
    });
  });

  it('collapses a bare city when a structured city/state form is present', () => {
    const parsed = parseLocationList([
      'Los Angeles',
      'Los Angeles, California, USA',
    ]);

    expect(parsed.labels).toEqual(['Los Angeles, CA, United States']);
    expect(parsed.location).toMatchObject({
      city: 'Los Angeles',
      state: 'CA',
      country: 'United States',
    });
  });

  it('never mints a Remote city with emitRemoteCity:false — qualifiers live in flags only', () => {
    const parsed = parseLocationList(['Remote', 'United States'], {
      emitRemoteCity: false,
    });

    expect(parsed.locations).toEqual([
      expect.objectContaining({ country: 'United States' }),
    ]);
    expect(parsed.location).toMatchObject({ country: 'United States' });
    expect(parsed.location?.city).toBeUndefined();
    expect(parsed.remoteMentioned).toBe(true);
    expect(parsed.workFromHomeType).toBe('Remote');
  });

  it('splits slash-separated multi-site strings into per-site entries', () => {
    const parsed = parseLocationList(['Toronto, ON', 'Atlanta / Savannah, GA']);

    expect(parsed.labels).toEqual(['Toronto, ON', 'Atlanta', 'Savannah, GA']);
    expect(parsed.locations[0]).toMatchObject({
      city: 'Toronto',
      state: 'ON',
    });
    expect(parsed.locations[2]).toMatchObject({
      city: 'Savannah',
      state: 'GA',
    });
  });
});

describe('LocationDto.text', () => {
  it('omits text when the label is trivially regenerable from fields', () => {
    const parsed = parseLocationList([
      'Seattle, WA',
      'Berlin, Germany',
      ' Bengaluru  ',
    ]);

    expect(parsed.locations.map((loc) => loc.text)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(parsed.locations[0]).toMatchObject({ city: 'Seattle', state: 'WA' });
    expect(parsed.locations[1]).toMatchObject({
      city: 'Berlin',
      country: 'Germany',
    });
    expect(parsed.locations[2]).toMatchObject({ city: 'Bengaluru' });
  });

  it('records the verbatim label when fields cannot regenerate it', () => {
    const parsed = parseLocationList([
      'Austin, TX - Atlas',
      'Remote United States',
    ]);

    expect(parsed.locations[0]).toMatchObject({
      city: 'Austin',
      state: 'TX',
      name: 'Atlas',
      text: 'Austin, TX - Atlas',
    });
    expect(parsed.locations[1]).toMatchObject({
      country: 'United States',
      text: 'Remote United States',
    });
  });

  it('omits text on the merged multi-site location, which is synthesized not raw', () => {
    const parsed = parseLocationList(['Seattle, WA', 'Austin, TX']);

    expect(parsed.location).toMatchObject({
      city: 'Seattle, WA; Austin, TX',
    });
    expect(parsed.location?.text).toBeUndefined();
  });

  it('omits text on a remote-only or country-only location, which has no site label', () => {
    expect(
      parseLocationList(['Remote', 'United States']).location?.text,
    ).toBeUndefined();
    expect(
      parseLocationList(['United States']).location?.text,
    ).toBeUndefined();
  });
});

describe('allowBareStateProvince (default on)', () => {
  it('resolves a bare US state name/code to state by default', () => {
    expect(parseLocationText('Virginia').location).toMatchObject({
      state: 'VA',
    });
    expect(parseLocationText('VA').location).toMatchObject({ state: 'VA' });
    expect(parseLocationList(['Virginia']).location).toMatchObject({
      state: 'VA',
    });
  });

  it('keeps a bare state name in city when a caller opts out', () => {
    expect(
      parseLocationText('Virginia', { allowBareStateProvince: false }).location,
    ).toMatchObject({ city: 'Virginia' });
    expect(
      parseLocationText('VA', { allowBareStateProvince: false }).location?.state,
    ).toBeUndefined();
  });

  it('never resolves collision names (Washington, New York, Georgia) to state', () => {
    for (const name of ['Washington', 'New York', 'Georgia']) {
      expect(parseLocationText(name).location).toMatchObject({ city: name });
    }
  });

  it('leaves a City, ST pair unchanged (no regression)', () => {
    expect(parseLocationText('Richmond, VA').location).toMatchObject({
      city: 'Richmond',
      state: 'VA',
    });
  });

  it('does not promote a non-state token', () => {
    expect(parseLocationText('Springfield').location).toMatchObject({
      city: 'Springfield',
    });
    expect(parseLocationText('Ontario').location).toMatchObject({
      city: 'Ontario',
    });
  });
});

describe('US subdivision recognition (spec 5130)', () => {
  it('resolves a state name in the city slot of "Name, Country"', () => {
    expect(parseLocationText('Arizona, USA').location).toMatchObject({
      state: 'AZ',
      country: 'United States',
    });
  });

  it('keeps collision names in the city slot ("New York, USA")', () => {
    expect(parseLocationText('New York, USA').location).toMatchObject({
      city: 'New York',
      country: 'United States',
    });
    expect(parseLocationText('New York, USA').location?.state).toBeUndefined();
  });

  it('emits territory names verbatim as state, not codes', () => {
    expect(parseLocationText('Puerto Rico, USA').location).toMatchObject({
      state: 'Puerto Rico',
      country: 'United States',
    });
    expect(parseLocationText('Puerto Rico').location).toMatchObject({
      state: 'Puerto Rico',
    });
    expect(parseLocationText('X, Puerto Rico').location).toMatchObject({
      city: 'X',
      state: 'Puerto Rico',
    });
  });

  it('normalizes dotted state codes (D.C., N.Y.)', () => {
    expect(parseLocationText('Washington, D.C').location).toMatchObject({
      city: 'Washington',
      state: 'DC',
    });
    expect(parseLocationText('Washington, D.C.').location).toMatchObject({
      city: 'Washington',
      state: 'DC',
    });
    expect(parseLocationText('Albany, N.Y.').location).toMatchObject({
      city: 'Albany',
      state: 'NY',
    });
  });

  it('splits an unseparated "City ST" label', () => {
    expect(parseLocationText('Bristol RI').location).toMatchObject({
      city: 'Bristol',
      state: 'RI',
    });
    expect(parseLocationText('San Juan PR').location).toMatchObject({
      city: 'San Juan',
      state: 'PR',
    });
    expect(parseLocationText('Washington D.C').location).toMatchObject({
      city: 'Washington',
      state: 'DC',
    });
  });

  it('splits "City ST" inside a comma pair with a country', () => {
    expect(parseLocationText('Bristol RI, USA').location).toMatchObject({
      city: 'Bristol',
      state: 'RI',
      country: 'United States',
    });
  });

  it('splits a comma-packed pair ending in a dotted code into two sites', () => {
    const parsed = parseLocationList(['Bristol, RI, Washington, D.C']);

    expect(parsed.locations).toHaveLength(2);
    expect(parsed.locations[0]).toMatchObject({
      city: 'Bristol',
      state: 'RI',
    });
    expect(parsed.locations[1]).toMatchObject({
      city: 'Washington',
      state: 'DC',
    });
  });

  it('does not split a bare label whose tail is not a US code', () => {
    expect(parseLocationText('Little Rock').location).toMatchObject({
      city: 'Little Rock',
    });
  });
});

describe('dash-prefixed US-state sites (spec 5131)', () => {
  it('parses a spaced ST - City prefix', () => {
    expect(parseLocationText('MA - Boston').location).toMatchObject({
      city: 'Boston',
      state: 'MA',
    });
  });

  it('parses an unspaced ST-City prefix', () => {
    expect(parseLocationText('MA-Boston').location).toMatchObject({
      city: 'Boston',
      state: 'MA',
    });
  });

  it('does not stamp a country on a solo ST - street site', () => {
    const loc = parseLocationText('MD - Gaither Rd.').location;
    expect(loc).toMatchObject({ state: 'MD', name: 'Gaither Rd.' });
    expect(loc?.country).toBeUndefined();
  });

  it('does not stamp a country on an unspaced ST-street site', () => {
    const loc = parseLocationText('MD-Gaither Rd.').location;
    expect(loc).toMatchObject({ state: 'MD', name: 'Gaither Rd.' });
    expect(loc?.country).toBeUndefined();
  });

  it('splits ST - street, City <descriptor>', () => {
    expect(
      parseLocationText('MD - Gaither Rd., Rockville Corp Hqtrs').location,
    ).toMatchObject({
      city: 'Rockville',
      state: 'MD',
      name: 'Gaither Rd. - Corp Hqtrs',
    });
  });

  it('keeps a ST - City as city and demotes the descriptor part to name', () => {
    expect(
      parseLocationText('MA - Boston, Rockville Corp Hqtrs').location,
    ).toMatchObject({
      city: 'Boston',
      state: 'MA',
      name: 'Rockville Corp Hqtrs',
    });
    expect(
      parseLocationText('MA-Boston, Rockville Corp Hqtrs').location,
    ).toMatchObject({
      city: 'Boston',
      state: 'MA',
      name: 'Rockville Corp Hqtrs',
    });
  });

  it('splits ST - street, City', () => {
    expect(
      parseLocationText('MD - Gaither Rd., Rockville').location,
    ).toMatchObject({
      city: 'Rockville',
      state: 'MD',
      name: 'Gaither Rd.',
    });
  });

  it('pops a literal country tail after a ST - site', () => {
    expect(
      parseLocationText('MD - Gaither Rd., Rockville, United States').location,
    ).toMatchObject({
      city: 'Rockville',
      state: 'MD',
      name: 'Gaither Rd.',
      country: 'United States',
    });
  });

  it('keeps a bare City <descriptor> as city without a ST - prefix', () => {
    expect(parseLocationText('Rockville Corp Hqtrs').location).toMatchObject({
      city: 'Rockville Corp Hqtrs',
    });
  });

  it('keeps a pure descriptor part as name after ST - City', () => {
    expect(parseLocationText('MA - Boston, Corp Hqtrs').location).toMatchObject(
      {
        city: 'Boston',
        state: 'MA',
        name: 'Corp Hqtrs',
      },
    );
  });

  it('does not read comma-tail subdivision codes as street suffixes', () => {
    expect(parseLocationText('Warsaw, PL').location).toMatchObject({
      city: 'Warsaw',
      country: 'Poland',
    });
  });

  it('keeps hyphenates and non-US dash prefixes whole', () => {
    expect(parseLocationText('CO-OP').location).toMatchObject({
      city: 'CO-OP',
    });
    expect(parseLocationText('T-Mobile').location).toMatchObject({
      city: 'T-Mobile',
    });
    expect(parseLocationText('MD - Remote').location).toMatchObject({
      state: 'MD',
    });
    expect(parseLocationText('ON - Toronto').location).toMatchObject({
      city: 'ON',
      name: 'Toronto',
    });
  });
});

/* ────────────────────────────────────────────────────────────────────── *
 *  Fork-sync hardening (Spec 1689)
 * ────────────────────────────────────────────────────────────────────── */

/** Env vars the parser reads; saved and restored around every test. */
const PARSER_ENV_NAMES = Object.values(LOCATION_PARSER_ENV);

function withParserEnv(): { set: (name: string, value: string) => void } {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of PARSER_ENV_NAMES) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    resetLocationParserEnvCache();
  });
  afterEach(() => {
    for (const name of PARSER_ENV_NAMES) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetLocationParserEnvCache();
  });
  return {
    set: (name, value) => {
      process.env[name] = value;
      resetLocationParserEnvCache();
    },
  };
}

/** Wall-clock milliseconds for one synchronous call. */
function timeMs(fn: () => unknown): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/**
 * Best of three runs — filters GC / scheduler noise on shared CI runners.
 * A super-linear regex would blow the budget on every run, not just one.
 */
function bestOf3Ms(fn: () => unknown): number {
  return Math.min(timeMs(fn), timeMs(fn), timeMs(fn));
}

/** Deterministic PRNG so the fuzz cases are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('ReDoS hardening (Spec 1689)', () => {
  withParserEnv();

  // the fork's exponential pattern — only ever run here, on SHORT inputs,
  // as the oracle for the linear replacement
  const LEGACY_REMOTE_IN_RE = /^(?:remote|hybrid)\b(?:[\s-]*\w+)*?\s+in\s+(.+)$/i;
  const BUDGET_MS = 50;

  beforeAll(() => {
    // warm the parser (JIT, Intl.DisplayNames) so budgets time steady state
    for (let i = 0; i < 50; i++) {
      parseLocationList(['Remote in Germany', 'Austin, TX', 'Toronto, ON']);
    }
  });

  it('matchRemoteInGeo agrees with the legacy regex on 3,000 short fuzz labels', () => {
    const tokens = [
      'Remote', 'remote', 'Hybrid', 'HYBRID', 'remotely', ' ', '  ', '\t', '\n',
      '-', ' - ', 'in', 'IN', ' in ', ' IN ', ' in in ', '- in', 'inn', 'a',
      'Bb', '1', '_', ',', '.', '(', ')', 'US', 'CO', 'Texas', 'the', 'é', '–',
    ];
    const heads = ['Remote', 'remote', 'Hybrid', 'hybrid', 'REMOTE', 'Hybridx', 'x'];
    const next = lcg(1689);
    let matched = 0;
    for (let i = 0; i < 3000; i++) {
      let label = heads[Math.floor(next() * heads.length)];
      const n = 1 + Math.floor(next() * 7);
      for (let t = 0; t < n; t++) {
        label += tokens[Math.floor(next() * tokens.length)];
      }
      if (label.length > 24) label = label.slice(0, 24);
      const legacy = LEGACY_REMOTE_IN_RE.exec(label);
      if (legacy) matched++;
      expect([label, matchRemoteInGeo(label)]).toEqual([
        label,
        legacy ? legacy[1] : null,
      ]);
    }
    // the fuzz exercises both outcomes, not just misses
    expect(matched).toBeGreaterThan(100);
  });

  it.each([
    ['Remote in United States', 'United States'],
    ['Hybrid - full time in Berlin', 'Berlin'],
    ['Remote in CO', 'CO'],
    ['Remote - in Paris', null],
    ['Remote, in Paris', null],
    ['Remotely in Paris', null],
    ['Remote Nationwide Opportunities Available', null],
  ])('matchRemoteInGeo(%j) -> %j', (label, geo) => {
    expect(matchRemoteInGeo(label)).toBe(geo);
  });

  it('matchRemoteInGeo stays linear on 7,000 rejected " in " candidates', () => {
    // every candidate's tail crosses the final line break, so all are rejected
    const label = `Remote${' in'.repeat(7_000)}\nx`;
    let geo: string | null = '';
    const ms = bestOf3Ms(() => {
      geo = matchRemoteInGeo(label);
    });
    expect(geo).toBe('x');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  const remoteHeavy = (length: number, head: string): string => {
    const words = ['Nationwide', 'Opportunities', 'Available', 'Immediately', 'Position'];
    let label = head;
    for (let i = 0; label.length < length; i++) label += ` ${words[i % words.length]}`;
    return label.slice(0, length);
  };

  it.each([
    ['60-char Remote label', remoteHeavy(60, 'Remote')],
    ['60-char Hybrid label', remoteHeavy(60, 'Hybrid')],
    ['500-char Remote label', remoteHeavy(500, 'Remote')],
    ['500-char Hybrid label', remoteHeavy(500, 'Hybrid')],
    ['500-char dashed Remote label', `Remote${'-Word'.repeat(99)}`],
  ])('parses a %s without " in " within budget (default cap and no cap)', (_name, label) => {
    expect(label).not.toMatch(/\sin\s/i);
    for (const maxLabelLength of [undefined, 0]) {
      const ms = bestOf3Ms(() => {
        parseLocationList([label], { maxLabelLength });
        parseLocationText(label, { maxLabelLength });
      });
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  it.each([
    ['slash runs', `Austin${'/ '.repeat(10_000)}TX`],
    ['comma runs', `Austin${', '.repeat(10_000)}TX`],
    ['semicolon runs', `Austin${'; '.repeat(10_000)}TX`],
    ['ampersand runs', `Austin${' & '.repeat(7_000)}TX`],
    ['dash runs', `Austin${' -'.repeat(10_000)}x`],
    ['serial-marker whitespace runs', `Austin${'(1)'.repeat(7_000)}x`],
    ['pipe runs', `Remote${' |'.repeat(10_000)} in X`],
    ['word runs after Remote', `Remote ${'a'.repeat(20_000)}`],
  ])('parses 20k-char %s within budget with the cap disabled', (_name, label) => {
    expect(label.length).toBeGreaterThanOrEqual(20_000);
    const ms = bestOf3Ms(() => parseLocationList([label], { maxLabelLength: 0 }));
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe('findUsAddressSnippet (Spec 1689)', () => {
  // the plugin regexes it replaces (workstream / harri), as oracles
  const REQUIRED_RE = /([A-Za-z\s]+,\s+[A-Z]{2}\s+\d{5})/;
  const OPTIONAL_RE = /([A-Za-z][A-Za-z\s]+,\s+[A-Z]{2}(?:\s+\d{5})?)/;

  it('matches both regexes on 5,000 short fuzz texts', () => {
    const tokens = [
      'San Jose', ' ', '  ', ',', ', ', ',  ', 'CA', 'ca', 'TX', ' 95130', '95130', '1030',
      'El Paseo', 'a', 'B', '.', '\n', '\t', '-', 'NYC', '12345', ' 1234',
      ', CA 95130', ', TX', 'Austin, TX 78701', ' Austin',
    ];
    const next = lcg(5150);
    let hits = 0;
    for (let i = 0; i < 5000; i++) {
      let text = '';
      const n = 1 + Math.floor(next() * 9);
      for (let t = 0; t < n; t++) text += tokens[Math.floor(next() * tokens.length)];
      const required = REQUIRED_RE.exec(text);
      const optional = OPTIONAL_RE.exec(text);
      if (required || optional) hits++;
      expect([text, findUsAddressSnippet(text, 'required')]).toEqual([
        text,
        required ? required[0] : null,
      ]);
      expect([text, findUsAddressSnippet(text, 'optional')]).toEqual([
        text,
        optional ? optional[0] : null,
      ]);
    }
    expect(hits).toBeGreaterThan(200);
  });

  it('finds the documented shapes', () => {
    expect(findUsAddressSnippet('Visit us at 1030 El Paseo, San Jose, CA 95130 today', 'optional')).toBe(
      'San Jose, CA 95130',
    );
    expect(findUsAddressSnippet('<p>Store: Austin, TX 78701</p>', 'required')).toBe(' Austin, TX 78701');
    expect(findUsAddressSnippet('Austin, TX', 'required')).toBeNull();
    expect(findUsAddressSnippet('Austin, TX', 'optional')).toBe('Austin, TX');
  });

  it.each([
    ['unpunctuated prose', 'lorem ipsum dolor sit amet '.repeat(4_000)],
    ['prose with commas and no state', 'lorem ipsum, dolor sit amet '.repeat(4_000)],
    ['a whitespace run', `a${' '.repeat(100_000)}, CA`],
  ])('stays linear on 100 KB of %s', (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(100_000);
    expect(bestOf3Ms(() => findUsAddressSnippet(text, 'required'))).toBeLessThan(50);
    expect(bestOf3Ms(() => findUsAddressSnippet(text, 'optional'))).toBeLessThan(50);
  });
});

describe('label length cap (Spec 1689)', () => {
  const env = withParserEnv();
  const long = `Austin, TX ${'x'.repeat(DEFAULT_MAX_LOCATION_LABEL_LENGTH)}`;

  it('keeps an over-cap label verbatim as one entry, skipping heuristics', () => {
    const parsed = parseLocationList([long, 'Denver, CO']);
    expect(parsed.locations[0]).toEqual(
      expect.objectContaining({ text: long, name: long }),
    );
    expect(parsed.locations[0].city).toBeUndefined();
    expect(parsed.locations[0].state).toBeUndefined();
    expect(parsed.locations[1]).toMatchObject({ city: 'Denver', state: 'CO' });
    expect(parsed.labels[0]).toBe(long);
  });

  it('never names a qualifier-flavored over-cap label, but keeps its flags', () => {
    const label = `Remote ${'Nationwide '.repeat(30)}`.trim();
    const parsed = parseLocationText(label);
    expect(parsed.location).toMatchObject({ text: label });
    expect(parsed.location?.name).toBeUndefined();
    expect(parsed.remoteMentioned).toBe(true);
  });

  it('leaves a label exactly at the cap to the heuristics', () => {
    const atCap = 'Austin, TX'.padEnd(DEFAULT_MAX_LOCATION_LABEL_LENGTH, 'x');
    expect(atCap.length).toBe(DEFAULT_MAX_LOCATION_LABEL_LENGTH);
    expect(parseLocationText(atCap).location).toMatchObject({ city: 'Austin' });
  });

  it('0 disables the cap; a per-call value overrides the env', () => {
    expect(parseLocationText(long, { maxLabelLength: 0 }).location).toMatchObject({
      city: 'Austin',
    });
    env.set(LOCATION_PARSER_ENV.maxLabelLength, '0');
    expect(parseLocationText(long).location).toMatchObject({ city: 'Austin' });
    expect(parseLocationText('Austin, TX', { maxLabelLength: 5 }).location).toEqual(
      expect.objectContaining({ text: 'Austin, TX' }),
    );
  });

  it('caps each ;/| site chunk, not the whole label: a long multi-site list stays structured', () => {
    const cities = Array.from(
      { length: 30 },
      (_, i) => `City${String.fromCharCode(65 + (i % 26))}${i}`,
    );
    const label = cities.map((c) => `${c}, TX`).join('; ');
    expect(label.length).toBeGreaterThan(DEFAULT_MAX_LOCATION_LABEL_LENGTH);
    const parsed = parseLocationList([label]);
    expect(parsed.locations).toHaveLength(30);
    expect(parsed.locations[0]).toMatchObject({ city: cities[0], state: 'TX' });
    expect(parsed.locations[29]).toMatchObject({ city: cities[29], state: 'TX' });
    expect(parsed.locations.some((l) => l.text?.includes(';'))).toBe(false);
    // pipe-separated too
    expect(
      parseLocationList([cities.map((c) => `${c}, CO`).join(' | ')]).locations,
    ).toHaveLength(30);
  });

  it('keeps only the over-cap chunk verbatim; its siblings still parse', () => {
    const longChunk = `Austin, TX ${'x'.repeat(DEFAULT_MAX_LOCATION_LABEL_LENGTH)}`;
    const parsed = parseLocationList([`Denver, CO; ${longChunk}; Boise, ID`]);
    expect(parsed.locations).toHaveLength(3);
    expect(parsed.locations[0]).toMatchObject({ city: 'Denver', state: 'CO' });
    expect(parsed.locations[1]).toEqual(expect.objectContaining({ text: longChunk }));
    expect(parsed.locations[1].city).toBeUndefined();
    expect(parsed.locations[2]).toMatchObject({ city: 'Boise', state: 'ID' });
  });

  it('reads EVER_JOBS_LOCATION_MAX_LABEL_LENGTH and ignores invalid values', () => {
    env.set(LOCATION_PARSER_ENV.maxLabelLength, '5');
    expect(parseLocationText('Austin, TX').location?.city).toBeUndefined();
    env.set(LOCATION_PARSER_ENV.maxLabelLength, 'not-a-number');
    expect(parseLocationText('Austin, TX').location).toMatchObject({
      city: 'Austin',
      state: 'TX',
    });
  });
});

describe('parser throughput (Spec 1689)', () => {
  withParserEnv();

  it('parses 5,000 typical labels in under 1.5 s', () => {
    const typical = [
      'San Francisco, CA', 'New York, NY, United States', 'Remote', 'Remote - US',
      'London, UK', 'Berlin, Germany', 'Austin, TX - Atlas', 'Toronto, ON',
      'Hybrid (Clarksburg, MD, US)', 'Denver, CO & San Francisco, CA',
      'Bengaluru', 'Remote in Germany', 'Seattle, WA; Portland, OR',
      'MA - Boston', 'Chennai, Tamil Nadu, India', 'Paris, FR',
      'Mountain View, California, United States', 'Remote, United States',
      'Fremont, CA, Salem, OR, Pittsburgh, PA', 'Tokyo, JP',
    ];
    // distinct strings, so nothing is served from a per-call cache
    const labels = Array.from(
      { length: 5000 },
      (_, i) => `${typical[i % typical.length]} ${'x'.repeat(i % 7)}`.trim(),
    );
    const ms = bestOf3Ms(() => {
      for (const label of labels) parseLocationList([label]);
    });
    expect(ms).toBeLessThan(1500);
  });

  it('handles a posting with 2,000 sites without quadratic blow-up and keeps dedup semantics', () => {
    const sites = Array.from(
      { length: 2000 },
      (_, i) => `City${String.fromCharCode(65 + (i % 26))}${i}, TX`,
    );
    const ms = bestOf3Ms(() => parseLocationList(sites));
    expect(ms).toBeLessThan(1500);
    const parsed = parseLocationList([...sites, 'CityA0', 'CityA0, TX, US']);
    // the bare 'CityA0' collapsed into the state-bearing entry
    expect(parsed.locations).toHaveLength(2000);
    // the country-bearing variant replaced the country-less one in place
    expect(parsed.locations[0]).toMatchObject({
      city: 'CityA0',
      state: 'TX',
      country: 'United States',
    });
  });

  it('keeps the country-lookup contract: names, aliases, ISO alpha-2/3, misses', () => {
    expect(normalizeCountryOnly('usa')).toBe('United States');
    expect(normalizeCountryOnly('U.S.')).toBe('United States');
    expect(normalizeCountryOnly('turkey')).toBe(normalizeCountryOnly('türkiye'));
    expect(normalizeCountryOnly('czechia')).toBe(
      normalizeCountryOnly('czech republic'),
    );
    expect(normalizeCountryOnly('NL')).toBe('Netherlands');
    expect(normalizeCountryOnly('GBR')).toBe('United Kingdom');
    expect(normalizeCountryOnly('korea')).toBe('South Korea');
    expect(normalizeCountryOnly('San Francisco')).toBeNull();
    expect(canonicalCountryName('UNITEDARABEMIRATES')).toBe('United Arab Emirates');
    expect(canonicalCountryName('US')).toBe('United States');
    expect(canonicalCountryName('Springfield')).toBeNull();
  });
});

describe('US-state-first reading of ambiguous codes (Spec 1689)', () => {
  const env = withParserEnv();

  it.each([
    ['Downtown, Los Angeles, CA', { city: 'Downtown, Los Angeles', state: 'CA' }],
    [
      'Mountain View, Santa Clara County, CA',
      { city: 'Mountain View, Santa Clara County', state: 'CA' },
    ],
    [
      'Springfield, Sangamon County, IL',
      { city: 'Springfield, Sangamon County', state: 'IL' },
    ],
    [
      'United States, San Diego, CA',
      { city: 'San Diego', state: 'CA', country: 'United States' },
    ],
    ['Remote in CO', { state: 'CO' }],
    ['Remote in Texas', { state: 'TX' }],
    ['Remote CA', { state: 'CA' }],
    ['Peru, Miami County, IN', { city: 'Peru, Miami County', state: 'IN' }],
    ['Mexico, Audrain County, MO', { city: 'Mexico, Audrain County', state: 'MO' }],
  ])('%s -> the US state, never a foreign country', (label, expected) => {
    const loc = parseLocationText(label).location;
    expect(loc).toMatchObject(expected);
    // US-state reading: the country is the literal one or unset (implied US)
    expect([undefined, 'United States']).toContain(loc?.country);
  });

  it.each([
    ['Toronto, Ontario, CA', 'Canada'],
    ['Berlin, Berlin, DE', 'Germany'],
    ['Chennai, Tamil Nadu, IN', 'India'],
    ['Bogotá, Cundinamarca, CO', 'Colombia'],
    ['Dubai, Dubai, AE', 'United Arab Emirates'],
    ['Haifa, Israel, IL', 'Israel'],
    ['Colombia, Medellín, CO', 'Colombia'],
  ])('%s keeps the ISO country (a non-US part pins it)', (label, country) => {
    expect(parseLocationText(label).location).toMatchObject({ country });
  });

  // 'City, <regional code>, <ISO country>' — the fork read these right; the
  // first cut of US-state-first misread every one as a US state
  it.each([
    ['Bengaluru, KA, IN', { city: 'Bengaluru', state: 'KA', country: 'India' }],
    ['Hyderabad, TS, IN', { city: 'Hyderabad', state: 'TS', country: 'India' }],
    ['Noida, UP, IN', { city: 'Noida', state: 'UP', country: 'India' }],
    ['Chennai, TN, IN', { city: 'Chennai', state: 'TN', country: 'India' }],
    ['Mumbai, MH, IN', { city: 'Mumbai', state: 'MH', country: 'India' }],
    ['Cologne, NW, DE', { city: 'Cologne', state: 'NW', country: 'Germany' }],
    [
      'Frankfurt am Main, HE, DE',
      { city: 'Frankfurt am Main', state: 'HE', country: 'Germany' },
    ],
    ['Munich, BY, DE', { city: 'Munich', state: 'BY', country: 'Germany' }],
    ['Berlin, BE, DE', { city: 'Berlin', state: 'BE', country: 'Germany' }],
    ['Medellin, ANT, CO', { city: 'Medellin', state: 'ANT', country: 'Colombia' }],
    [
      'Petah Tikva, Central, IL',
      { city: 'Petah Tikva', state: 'Central', country: 'Israel' },
    ],
  ])('%s keeps the country and its region code', (label, expected) => {
    const loc = parseLocationText(label).location;
    expect({ city: loc?.city, state: loc?.state, country: loc?.country }).toEqual(
      expected,
    );
  });

  it.each([
    ['Remote, DE', 'Germany'],
    ['Remote, IN', 'India'],
    ['Remote, CA', 'Canada'],
    ['Hybrid, CA', 'Canada'],
  ])('%s keeps the fork country reading by default', (label, country) => {
    const loc = parseLocationText(label).location;
    expect(loc).toMatchObject({ country });
    expect(loc?.state).toBeUndefined();
  });

  it('preferUsStateAfterQualifier reads a lone code after a comma qualifier as the state', () => {
    const opts = { preferUsStateAfterQualifier: true };
    for (const [label, state] of [
      ['Remote, CA', 'CA'],
      ['Remote, DE', 'DE'],
      ['Hybrid, IN', 'IN'],
    ]) {
      const loc = parseLocationText(label, opts).location;
      expect(loc).toMatchObject({ state });
      expect(loc?.country).toBeUndefined();
    }
    // only a sub-option of US-state-first
    expect(
      parseLocationText('Remote, CA', { ...opts, preferUsStateCode: false }).location,
    ).toMatchObject({ country: 'Canada' });
  });

  it('EVER_JOBS_LOCATION_PREFER_US_STATE_AFTER_QUALIFIER=true sets it as the default', () => {
    env.set(LOCATION_PARSER_ENV.preferUsStateAfterQualifier, 'true');
    expect(parseLocationText('Remote, CA').location).toMatchObject({ state: 'CA' });
    expect(
      parseLocationText('Remote, CA', { preferUsStateAfterQualifier: false }).location,
    ).toMatchObject({ country: 'Canada' });
  });

  it('preferUsStateCode:false keeps the fork reading of the region-code labels', () => {
    const opts = { preferUsStateCode: false };
    expect(parseLocationText('Bengaluru, KA, IN', opts).location).toMatchObject({
      city: 'Bengaluru',
      state: 'KA',
      country: 'India',
    });
    // the fork's middle-part veto ('Pueblo, CO Penrose, CO') also caught a
    // bare middle code — unchanged with the option off
    expect(parseLocationText('Chennai, TN, IN', opts).location).toMatchObject({
      city: 'Chennai, TN',
      state: 'IN',
    });
  });

  it('keeps the fork middle-part veto ("Pueblo, CO Penrose, CO")', () => {
    expect(parseLocationText('Pueblo, CO Penrose, CO').location).toMatchObject({
      city: 'Pueblo, CO Penrose',
      state: 'CO',
    });
  });

  it('preferUsStateCode:false restores the fork ISO-country-first reading', () => {
    const opts = { preferUsStateCode: false };
    expect(parseLocationText('Downtown, Los Angeles, CA', opts).location).toMatchObject({
      city: 'Downtown',
      state: 'Los Angeles',
      country: 'Canada',
    });
    expect(
      parseLocationText('Springfield, Sangamon County, IL', opts).location,
    ).toMatchObject({ country: 'Israel' });
    expect(parseLocationText('Remote in CO', opts).location).toMatchObject({
      country: 'Colombia',
    });
    expect(parseLocationText('Remote, CA', opts).location).toMatchObject({
      country: 'Canada',
    });
  });

  it('EVER_JOBS_LOCATION_PREFER_US_STATE=false sets the fork reading as the default', () => {
    env.set(LOCATION_PARSER_ENV.preferUsStateCode, 'false');
    expect(parseLocationText('Remote in CO').location).toMatchObject({
      country: 'Colombia',
    });
    // a per-call option still wins over the env
    expect(
      parseLocationText('Remote in CO', { preferUsStateCode: true }).location,
    ).toMatchObject({ state: 'CO' });
  });

  it('a lone ambiguous code after a qualifier honours the bare-state option', () => {
    expect(
      parseLocationText('Remote, CA', {
        allowBareStateProvince: false,
        preferUsStateAfterQualifier: true,
      }).location,
    ).toMatchObject({ city: 'CA' });
  });
});

describe('restorable legacy behaviour (Spec 1689)', () => {
  const env = withParserEnv();

  it('emitRemoteCity restores { city: "Remote", country } for remote-only input', () => {
    const opts = { emitRemoteCity: true };
    expect(parseLocationList(['Remote'], opts).location).toMatchObject({
      city: 'Remote',
    });
    const withCountry = parseLocationList(['Remote', 'United States'], opts);
    expect(withCountry.location).toMatchObject({
      city: 'Remote',
      country: 'United States',
    });
    // per-site entries are unchanged
    expect(withCountry.locations).toEqual([
      expect.objectContaining({ country: 'United States' }),
    ]);
    expect(parseLocationText('Remote - US', opts).location).toMatchObject({
      city: 'Remote',
      country: 'United States',
    });
  });

  it('emitRemoteCity never replaces a concrete site', () => {
    expect(
      parseLocationList(['Remote', 'Austin, TX'], { emitRemoteCity: true }).location,
    ).toMatchObject({ city: 'Austin', state: 'TX' });
  });

  it('EVER_JOBS_LOCATION_REMOTE_CITY=true turns it on by default; the default stays off', () => {
    expect(parseLocationList(['Remote']).location).toBeNull();
    env.set(LOCATION_PARSER_ENV.emitRemoteCity, 'true');
    expect(parseLocationList(['Remote']).location).toMatchObject({
      city: 'Remote',
    });
    // a per-call option still wins over the env
    expect(
      parseLocationList(['Remote'], { emitRemoteCity: false }).location,
    ).toBeNull();
  });

  it('EVER_JOBS_LOCATION_BARE_STATE=false restores the old opt-in default', () => {
    env.set(LOCATION_PARSER_ENV.allowBareStateProvince, 'false');
    expect(parseLocationText('Virginia').location).toMatchObject({
      city: 'Virginia',
    });
    expect(parseLocationText('VA').location?.state).toBeUndefined();
    // per-call opt-in still works
    expect(
      parseLocationText('Virginia', { allowBareStateProvince: true }).location,
    ).toMatchObject({ state: 'VA' });
  });

  it('reads the env once until the cache is reset', () => {
    expect(parseLocationList(['Remote']).location).toBeNull();
    process.env[LOCATION_PARSER_ENV.emitRemoteCity] = 'true';
    expect(parseLocationList(['Remote']).location).toBeNull(); // cached
    resetLocationParserEnvCache();
    expect(parseLocationList(['Remote']).location).toMatchObject({
      city: 'Remote',
    });
  });
});

describe('golden values (Spec 1689)', () => {
  withParserEnv();

  // literal expectations — the plugin specs derive theirs from the parser,
  // so these pin what the parser itself must produce
  it.each([
    ['San Francisco, CA', { city: 'San Francisco', state: 'CA' }],
    [
      'New York, NY, United States',
      { city: 'New York', state: 'NY', country: 'United States' },
    ],
    ['Austin, TX, USA', { city: 'Austin', state: 'TX', country: 'United States' }],
    ['London, UK', { city: 'London', country: 'United Kingdom' }],
    ['Berlin, Germany', { city: 'Berlin', country: 'Germany' }],
    ['Warsaw, PL', { city: 'Warsaw', country: 'Poland' }],
    ['Tokyo, JP', { city: 'Tokyo', country: 'Japan' }],
    ['Toronto, ON', { city: 'Toronto', state: 'ON' }],
    [
      'Toronto, Ontario, CA',
      { city: 'Toronto', state: 'Ontario', country: 'Canada' },
    ],
    [
      'Chennai, Tamil Nadu, India',
      { city: 'Chennai', state: 'Tamil Nadu', country: 'India' },
    ],
    [
      'Amsterdam, North Holland, Netherlands',
      { city: 'Amsterdam', state: 'North Holland', country: 'Netherlands' },
    ],
    ['São Paulo, Brazil', { city: 'São Paulo', country: 'Brazil' }],
    ['Singapore', { country: 'Singapore' }],
    ['Bengaluru', { city: 'Bengaluru' }],
    ['Virginia', { state: 'VA' }],
    ['MA - Boston', { city: 'Boston', state: 'MA' }],
    ['Austin, TX - Atlas', { city: 'Austin', state: 'TX', name: 'Atlas' }],
    ['Remote in Germany', { country: 'Germany' }],
    ['Remote - US', { country: 'United States' }],
    ['Remote (Paris, FR)', { city: 'Paris', country: 'France' }],
    [
      'Hybrid (Clarksburg, MD, US)',
      { city: 'Clarksburg', state: 'MD', country: 'United States' },
    ],
    ['Downtown, Los Angeles, CA', { city: 'Downtown, Los Angeles', state: 'CA' }],
  ])('%s', (label, expected) => {
    const loc = parseLocationText(label).location;
    // exact geography: no extra city/state/country/name beyond the expected
    expect({
      city: loc?.city ?? undefined,
      state: loc?.state ?? undefined,
      country: loc?.country ?? undefined,
      name: loc?.name ?? undefined,
    }).toEqual({
      city: undefined,
      state: undefined,
      country: undefined,
      name: undefined,
      ...expected,
    });
  });

  it('Remote alone has no location, only flags', () => {
    expect(parseLocationText('Remote')).toEqual({
      location: null,
      remoteMentioned: true,
      workFromHomeType: 'Remote',
    });
  });

  it('Remote alone is the legacy { city: "Remote" } with emitRemoteCity:true', () => {
    expect(parseLocationText('Remote', { emitRemoteCity: true }).location).toEqual(
      expect.objectContaining({ city: 'Remote' }),
    );
  });

  it.each([
    ['Remote in Germany', 'Germany'],
    ['Remote - US', 'United States'],
    ['United States (Remote)', 'United States'],
    ['Remote - Canada', 'Canada'],
  ])('%s with emitRemoteCity:true -> { city: "Remote", country } (the legacy reading)', (label, country) => {
    const loc = parseLocationText(label, { emitRemoteCity: true }).location;
    expect({ city: loc?.city, country: loc?.country }).toEqual({ city: 'Remote', country });
  });

  it('Denver, CO & San Francisco, CA splits into two sites', () => {
    const parsed = parseLocationList(['Denver, CO & San Francisco, CA']);
    expect(parsed.labels).toEqual(['Denver, CO', 'San Francisco, CA']);
    expect(parsed.location).toMatchObject({
      city: 'Denver, CO; San Francisco, CA',
    });
    expect(parsed.location?.country).toBeUndefined();
  });
});
