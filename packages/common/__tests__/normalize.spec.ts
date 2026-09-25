import {
  normalizeCompany,
  normalizeLocation,
  normalizeTitle,
  stripParentheticals,
} from '@ever-jobs/common';

/**
 * Best of three wall-clock runs, in ms. One run can overshoot a small budget
 * on a throttled CI pod (CFS quota, GC pause); a super-linear regex overshoots
 * it on every run, by orders of magnitude.
 */
function bestOf3Ms(fn: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    fn();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('normalizeCompany (Spec 003 / T04)', () => {
  it.each<[string, string]>([
    ['Acme, Inc.', 'acme'],
    ['ACME Corporation', 'acme'],
    ['Some Co., Ltd.', 'some'],
    ['Müller GmbH', 'muller'],
    ['OpenAI, L.L.C.', 'openai'],
    ['Stripe', 'stripe'],
    ['Smith & Sons Inc', 'smith sons'],
    ['Apple Computer Inc.', 'apple computer'],
    ['Acme Holdings', 'acme'],
    ['  Acme   ', 'acme'],
  ])('normalizeCompany(%j) === %j', (input, expected) => {
    expect(normalizeCompany(input)).toBe(expected);
  });

  it('returns empty string for null/undefined/empty', () => {
    expect(normalizeCompany(null)).toBe('');
    expect(normalizeCompany(undefined)).toBe('');
    expect(normalizeCompany('')).toBe('');
  });

  it('is idempotent', () => {
    const inputs = ['Acme, Inc.', 'ACME Corporation', 'Müller GmbH', 'Smith & Sons Inc'];
    for (const input of inputs) {
      const once = normalizeCompany(input);
      const twice = normalizeCompany(once);
      expect(twice).toBe(once);
    }
  });
});

describe('normalizeTitle (Spec 003 / T04)', () => {
  it.each<[string, string]>([
    ['Sr. Software Engineer', 'senior swe'],
    ['Senior Software Engineer (Remote)', 'senior swe'],
    ['ML Engineer III', 'ml engineer 3'],
    ['Senior  Software   Engineer', 'senior swe'],
    ['Software Engineer II', 'swe 2'],
    ['Jr Data Scientist', 'junior ds'],
    ['Backend Engineer / Go', 'backend engineer go'],
    ['Engineer | Remote', 'engineer remote'],
    ['Site Reliability Engineer', 'sre'],
    ['Product Manager', 'pm'],
  ])('normalizeTitle(%j) === %j', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeTitle(null)).toBe('');
    expect(normalizeTitle(undefined)).toBe('');
  });

  it('is idempotent', () => {
    const inputs = ['Sr. SWE', 'ML Engineer III', 'Senior Software Engineer (Remote)'];
    for (const input of inputs) {
      const once = normalizeTitle(input);
      expect(normalizeTitle(once)).toBe(once);
    }
  });
});

describe('normalizeLocation (Spec 003 / T04)', () => {
  it.each<[string, string]>([
    ['Remote', 'remote'],
    ['Anywhere', 'remote'],
    ['Work From Home', 'remote'],
    ['Remote, US', 'remote'],
    ['San Francisco, CA', 'san francisco california'],
    ['New York, NY, USA', 'new york new york usa'],
    ['Berlin, Germany', 'berlin germany'],
    ['  London,  UK  ', 'london uk'],
  ])('normalizeLocation(%j) === %j', (input, expected) => {
    expect(normalizeLocation(input)).toBe(expected);
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeLocation(null)).toBe('');
    expect(normalizeLocation(undefined)).toBe('');
  });

  it('is idempotent', () => {
    const inputs = ['San Francisco, CA', 'Remote, US', 'Berlin, Germany'];
    for (const input of inputs) {
      const once = normalizeLocation(input);
      expect(normalizeLocation(once)).toBe(once);
    }
  });

  it('detects remote on every call regardless of call order', () => {
    // Guards against a stateful /g regex whose lastIndex would make
    // consecutive .test() calls alternate match/no-match.
    for (let i = 0; i < 5; i++) {
      expect(normalizeLocation('Anywhere')).toBe('remote');
      expect(normalizeLocation('Remote, US')).toBe('remote');
    }
  });
});

describe('normalizeTitle — linear noise stripping (Spec 1689)', () => {
  // the former regex pipeline, kept here as the oracle for the linear strip
  const legacyTitle = (input: string): string => {
    let s = input
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[   ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    for (const re of [/\([^)]*\)/g, /\[[^\]]*\]/g, /[/|]/g]) s = s.replace(re, ' ');
    return s;
  };

  it('strips the same spans as the former regexes on 3,000 fuzz titles', () => {
    const alphabet = ['(', ')', '[', ']', 'a', 'Sr.', ' ', '/', '|', 'Engineer', '(Remote)', '[NYC]'];
    let seed = 1689;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 3000; i++) {
      let title = '';
      const n = 1 + Math.floor(next() * 12);
      for (let t = 0; t < n; t++) title += alphabet[Math.floor(next() * alphabet.length)];
      // legacy-stripped text, leftover delimiters blanked (PUNCT_RE does the
      // same on the real path), then the unchanged rest of normalizeTitle
      const expected = normalizeTitle(legacyTitle(title).replace(/[()[\]]/g, ' '));
      expect([title, normalizeTitle(title)]).toEqual([title, expected]);
    }
  });

  it.each([
    ['unclosed parens', '('.repeat(20_000)],
    ['unclosed brackets', '['.repeat(20_000)],
    ['open-paren words', '(a'.repeat(10_000)],
  ])('normalises a 20k-char title of %s in linear time', (_name, title) => {
    expect(bestOf3Ms(() => normalizeTitle(title))).toBeLessThan(50);
  });
});

describe('stripParentheticals — linear paren strip for plugins (Spec 1689)', () => {
  // the regexes plugins used, as oracles (short inputs only)
  const ORACLES = {
    keep: (s: string, r: string) => s.replace(/\([^)]*\)/g, r),
    before: (s: string, r: string) => s.replace(/\s*\([^)]*\)/g, r),
    around: (s: string, r: string) => s.replace(/\s*\([^)]*\)\s*/g, r),
  } as const;

  it.each(Object.keys(ORACLES) as Array<keyof typeof ORACLES>)(
    "space '%s' matches its regex on 3,000 fuzz labels",
    (space) => {
      const alphabet = ['(', ')', ' ', '  ', '\t', '\n', 'a', 'Leeds', ',', 'UK', '(HQ)', ')('];
      let seed = 1689;
      const next = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
      };
      for (let i = 0; i < 3000; i++) {
        let label = '';
        const n = 1 + Math.floor(next() * 10);
        for (let t = 0; t < n; t++) label += alphabet[Math.floor(next() * alphabet.length)];
        for (const replacement of ['', ' ']) {
          expect([label, replacement, stripParentheticals(label, replacement, { space })]).toEqual([
            label,
            replacement,
            ORACLES[space](label, replacement),
          ]);
        }
      }
    },
  );

  it('keeps the documented examples', () => {
    expect(stripParentheticals('Leeds (Head Office), UK', '', { space: 'before' })).toBe('Leeds, UK');
    expect(stripParentheticals('Paris (75) - IDF', ' ', { space: 'around' })).toBe('Paris - IDF');
    expect(stripParentheticals('Austin (On-site)', '')).toBe('Austin ');
    expect(stripParentheticals('no parens')).toBe('no parens');
  });

  it.each([
    ['unclosed parens', '('.repeat(20_000)],
    ['whitespace run then a span', `${' '.repeat(20_000)}(x)`],
    ['whitespace runs without a span', `a${' '.repeat(20_000)}b`],
    ['open-paren words', '(a'.repeat(10_000)],
  ])('strips a 20k-char label of %s in linear time (every mode)', (_name, label) => {
    for (const space of ['keep', 'before', 'around'] as const) {
      expect(bestOf3Ms(() => stripParentheticals(label, ' ', { space }))).toBeLessThan(50);
    }
  });
});
