import { CompensationInterval } from '@ever-jobs/models';
import {
  buildMatchFields,
  cleanTitle,
  foldText,
  hasToken,
  isBoardHost,
  isBoardIndexUrl,
  isJobEntry,
  legacyCompensation,
  legacyPhraseMatch,
  matchTier,
  normalizeUrl,
  parseFeedPayload,
  parseLegacyMode,
  pickTagSeed,
  plausibleCompensation,
  repairMojibake,
  resolveApplyUrls,
  resolveJobUrl,
  tidyLocation,
  tokenizeSearchTerm,
} from '../src/remoteok.text';

/**
 * Spec 1707 - pure helpers of the RemoteOK source.
 *
 * Mojibake literals are written as \xNN escapes (UTF-8 bytes read as
 * Latin-1), so no editor or line-ending conversion can alter them.
 */

const BASE = 'https://remoteok.com';

describe('repairMojibake', () => {
  const cases: Array<[string, string, string]> = [
    ['two-byte letter', 'grabaci\xC3\xB3n', 'grabaci\xF3n'],
    ['three-byte symbol', 'Immunix\xE2\x84\xA2 platform', 'Immunix\u{2122} platform'],
    ['em dash', 'Lead \xE2\x80\x94 Ops', 'Lead \u{2014} Ops'],
    ['right quote', 'You\xE2\x80\x99ll', 'You\u{2019}ll'],
    ['registered sign', 'Acme\xC2\xAE', 'Acme\xAE'],
    ['Arabic city', '\xD9\x85\xD8\xB3\xD9\x82\xD8\xB7', '\u{645}\u{633}\u{642}\u{637}'],
    ['four-byte emoji', 'ok \xF0\x9F\x98\x85', 'ok \u{1F605}'],
    ['triple-encoded check mark', '\xC3\xA2\xC2\x9C\xC2\x85 done', '\u{2705} done'],
    ['truncated three-byte tail', 'Representative Attribute\xE2\x84', 'Representative Attribute'],
    ['truncated two-byte tail', 'Customer Support Agent \xC2\xB7 \xC2', 'Customer Support Agent \xB7 '],
    ['repaired trailing letter survives', 'Caf\xC3\xA9', 'Caf\xE9'],
    ['mixed mojibake and clean text', 'Mixed \xE2\x80\x94 Caf\xE9 ok', 'Mixed \u{2014} Caf\xE9 ok'],
    ['stray C1 control', 'a\x85b', 'ab'],
  ];

  it.each(cases)('%s', (_label, input, expected) => {
    expect(repairMojibake(input)).toBe(expected);
  });

  it.each(['Caf\xE9', 'S\xE3o Paulo', 'Gr\xF6\xDFe', 'na\xEFve', '\u{65E5}\u{672C}\u{8A9E}', 'plain ASCII, 100%'])(
    'leaves clean text %p untouched',
    (clean) => {
      expect(repairMojibake(clean)).toBe(clean);
    },
  );

  it('passes null, undefined and empty through', () => {
    expect(repairMojibake(null)).toBeNull();
    expect(repairMojibake(undefined)).toBeUndefined();
    expect(repairMojibake('')).toBe('');
  });

  it('is idempotent on every case', () => {
    for (const [, input] of cases) {
      const once = repairMojibake(input);
      expect(repairMojibake(once)).toBe(once);
    }
  });

  it('keeps a run that is not valid UTF-8 verbatim (no U+FFFD)', () => {
    // \xC3 followed by \xC3 is two lead bytes: that run cannot decode and stays.
    const out = repairMojibake('A\xC3\xC3B \xE2\x80\x94');
    expect(out).toBe('A\xC3\xC3B \u{2014}');
    expect(out).not.toContain('\u{FFFD}');
  });

  it('stays linear on a long flagged string', () => {
    const long = `${'x\xC3\xA9 '.repeat(20000)}\xE2\x84`;
    const started = Date.now();
    const out = repairMojibake(long);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out.endsWith('x\xE9 ')).toBe(true);
  });
});

describe('cleanTitle', () => {
  it('drops a cut separator tail after repair', () => {
    expect(cleanTitle(repairMojibake('Customer Support Agent \xC2\xB7 \xC2'))).toBe('Customer Support Agent');
  });

  it.each([
    ['Engineer - ', 'Engineer'],
    ['Engineer |', 'Engineer'],
    ['Engineer \u{2014}', 'Engineer'],
    ['  Engineer  ', 'Engineer'],
    ['Python\n Developer', 'Python Developer'],
    ['Data\t\tEngineer\u{A0}- ', 'Data Engineer'],
    ['C++ Engineer', 'C++ Engineer'],
    ['', ''],
  ])('%p -> %p', (input, expected) => {
    expect(cleanTitle(input)).toBe(expected);
  });

  it('returns an empty string for a non-string', () => {
    expect(cleanTitle(undefined)).toBe('');
  });

  it('stays linear on a long inner separator run', () => {
    const title = `a${' -'.repeat(50000)} b`;
    const started = Date.now();
    const out = cleanTitle(title);
    expect(Date.now() - started).toBeLessThan(500);
    expect(out === title).toBe(true);
    expect(cleanTitle(`a${' '.repeat(100000)}b`) === 'a b').toBe(true);
  });
});

describe('foldText / tokenizeSearchTerm', () => {
  it('folds case and diacritics', () => {
    expect(foldText('Caf\xE9 S\xC3O')).toBe('cafe sao');
    expect(foldText(null)).toBe('');
  });

  it.each<[string, string[]]>([
    ['Senior Python Developer', ['senior', 'python', 'developer']],
    ['C++ / C#', ['c++', 'c#']],
    ['Node.js', ['node.js']],
    ['remote jobs', []],
    ['Caf\xE9', ['cafe']],
    ['python python PYTHON', ['python']],
    ['React.', ['react']],
    ['', []],
  ])('%p -> %j', (term, expected) => {
    expect(tokenizeSearchTerm(term)).toEqual(expected);
  });

  it('handles null and caps the token count', () => {
    expect(tokenizeSearchTerm(null)).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    expect(tokenizeSearchTerm(many)).toHaveLength(16);
  });
});

describe('pickTagSeed', () => {
  it.each<[string[], string | null]>([
    [['python'], 'python'],
    [['senior', 'python', 'developer'], 'python'],
    [['software', 'engineer'], 'software'],
    [['senior', 'engineer'], null],
    [['c++'], null],
    [['node.js'], null],
    [['go', 'rust'], 'rust'],
    [['java', 'rust'], 'java'],
    [['2026'], null],
    [[], null],
  ])('%j -> %p', (tokens, expected) => {
    expect(pickTagSeed(tokens)).toBe(expected);
  });
});

describe('hasToken', () => {
  it.each<[string, string, boolean]>([
    ['javascript developer', 'java', false],
    ['java developer', 'java', true],
    ['google cloud', 'go', false],
    ['argo and django', 'go', false],
    ['javascript', 'script', false],
    ['write go services', 'go', true],
    ['senior engineers wanted', 'engineer', true],
    ['modern c++ codebase', 'c++', true],
    ['c#/.net stack', 'c#', true],
    ['node.js and react', 'node.js', true],
    ['python3', 'python', false],
    ['', 'python', false],
    ['python', '', false],
  ])('%p has %p: %p', (hay, token, expected) => {
    expect(hasToken(hay, token)).toBe(expected);
  });
});

describe('matchTier', () => {
  const fields = buildMatchFields(
    'Senior Python Engineer',
    'Globex Labs',
    'We build data pipelines in Rust.',
    ['golang', 'customer support'],
  );

  it('ranks title, then company/description, then tag-only evidence', () => {
    expect(matchTier(fields, ['python'])).toBe(0);
    expect(matchTier(fields, ['senior', 'python'])).toBe(0);
    expect(matchTier(fields, ['globex'])).toBe(1);
    expect(matchTier(fields, ['python', 'rust'])).toBe(1);
    expect(matchTier(fields, ['golang'])).toBe(2);
    expect(matchTier(fields, ['customer', 'support'])).toBe(2);
    expect(matchTier(fields, ['python', 'haskell'])).toBeNull();
  });

  it('is tier 0 with no tokens', () => {
    expect(matchTier(fields, [])).toBe(0);
  });

  it('does not join words across fields', () => {
    const joined = buildMatchFields('Data', 'Engineer Co', '', []);
    expect(hasToken(joined.core, 'data')).toBe(true);
    expect(matchTier(joined, ['dataengineer'])).toBeNull();
  });
});

describe('legacyPhraseMatch', () => {
  it('keeps the pre-1707 substring semantics', () => {
    expect(legacyPhraseMatch('JavaScript Developer', [], 'java')).toBe(true);
    expect(legacyPhraseMatch('Designer', ['golang'], 'go')).toBe(true);
    expect(legacyPhraseMatch('Senior Engineer', ['python'], 'senior python')).toBe(false);
  });
});

describe('tidyLocation', () => {
  it.each<[string | null | undefined, string | null]>([
    ['Austin, Austin, Texas, United States', 'Austin, Texas, United States'],
    ['S\xE3o Paulo, S\xE3o Paulo, S\xE3o Paulo, Brasil', 'S\xE3o Paulo, Brasil'],
    ['California, california, United States', 'California, United States'],
    ['Brasil, ', 'Brasil'],
    ['Remote, ', 'Remote'],
    ['Remoto', 'Remote'],
    ['remota', 'Remote'],
    ['Worldwide', 'Remote'],
    ['Anywhere', 'Remote'],
    ['Remote UK', 'Remote UK'],
    ['', null],
    [' , , ', null],
    [null, null],
    [undefined, null],
  ])('%p -> %p', (input, expected) => {
    expect(tidyLocation(input)).toBe(expected);
  });
});

describe('plausibleCompensation / legacyCompensation', () => {
  it('emits a plausible pair as yearly USD', () => {
    const c = plausibleCompensation(60000, 80000);
    expect(c).toMatchObject({
      interval: CompensationInterval.YEARLY,
      minAmount: 60000,
      maxAmount: 80000,
      currency: 'USD',
    });
  });

  it('keeps one-sided values', () => {
    const minOnly = plausibleCompensation(80000, 0);
    expect(minOnly).toMatchObject({ minAmount: 80000, currency: 'USD' });
    expect(minOnly?.maxAmount).toBeUndefined();
    expect(plausibleCompensation(0, 120000)).toMatchObject({ maxAmount: 120000 });
  });

  it.each<[unknown, unknown]>([
    [0, 0],
    [30, 36],
    [10000, 750000],
    [90000, 60000],
    [-5, -1],
    [undefined, undefined],
    ['abc', null],
    [Number.NaN, Number.POSITIVE_INFINITY],
  ])('rejects (%p, %p)', (min, max) => {
    expect(plausibleCompensation(min, max)).toBeNull();
  });

  it('accepts numeric strings', () => {
    expect(plausibleCompensation('70000', '90000')).toMatchObject({ minAmount: 70000, maxAmount: 90000 });
  });

  it('legacy rule emits any both-positive pair', () => {
    expect(legacyCompensation(30, 36)).toMatchObject({ minAmount: 30, maxAmount: 36 });
    expect(legacyCompensation(80000, 0)).toBeNull();
  });
});

describe('URLs', () => {
  it('normalises case and rejects other schemes', () => {
    expect(normalizeUrl('https://remoteOK.com/remote-jobs/x-1')).toBe('https://remoteok.com/remote-jobs/x-1');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://example.com/a')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl(42)).toBeNull();
    expect(normalizeUrl('/assets/logo.png', BASE)).toBe('https://remoteok.com/assets/logo.png');
  });

  it('knows the board hosts', () => {
    expect(isBoardHost('https://remoteok.io/x')).toBe(true);
    expect(isBoardHost('https://www.remoteok.com/x')).toBe(true);
    expect(isBoardHost('https://boards.example.com/x')).toBe(false);
    expect(isBoardHost('https://notremoteok.com/x')).toBe(false);
    expect(isBoardHost(null)).toBe(false);
  });

  it('tells an index page from a job page', () => {
    expect(isBoardIndexUrl('https://remoteok.com/remote-jobs/')).toBe(true);
    expect(isBoardIndexUrl('https://remoteok.com/')).toBe(true);
    expect(isBoardIndexUrl('https://remoteok.com/remote-jobs/x-1')).toBe(false);
    expect(isBoardIndexUrl('https://jobs.example.com/')).toBe(false);
  });

  it('resolves the job page: url, then slug, then numeric id', () => {
    expect(resolveJobUrl({ id: '1', url: 'https://remoteOK.com/remote-jobs/a-1', slug: 'a-1' }, BASE)).toBe(
      'https://remoteok.com/remote-jobs/a-1',
    );
    expect(resolveJobUrl({ id: '2', slug: 'b-2' }, BASE)).toBe('https://remoteok.com/remote-jobs/b-2');
    expect(resolveJobUrl({ id: '3', url: 'https://remoteOK.com/remote-jobs/', slug: '' }, BASE)).toBe(
      'https://remoteok.com/remote-jobs/3',
    );
    expect(resolveJobUrl({ id: 'x', url: 'javascript:1', slug: '../../etc' }, BASE)).toBeNull();
  });

  it('only calls an off-board apply link direct', () => {
    const job = 'https://remoteok.com/remote-jobs/a-1';
    expect(resolveApplyUrls('https://remoteOK.com/remote-jobs/a-1', job)).toEqual({
      applyUrl: job,
      jobUrlDirect: null,
    });
    expect(resolveApplyUrls('https://jobs.example.com/apply/1', job)).toEqual({
      applyUrl: 'https://jobs.example.com/apply/1',
      jobUrlDirect: 'https://jobs.example.com/apply/1',
    });
    expect(resolveApplyUrls(undefined, job)).toEqual({ applyUrl: job, jobUrlDirect: null });
    expect(resolveApplyUrls('https://remoteOK.com/remote-jobs/', job)).toEqual({ applyUrl: job, jobUrlDirect: null });
  });
});

describe('feed payload', () => {
  const meta = { last_updated: 1790265606, legal: 'test terms' };
  const row = { id: '1', position: 'Engineer' };

  it('keeps job rows and skips the metadata row by shape, wherever it is', () => {
    expect(parseFeedPayload([meta, row])).toEqual([row]);
    expect(parseFeedPayload([row, meta])).toEqual([row]);
    expect(parseFeedPayload([meta])).toEqual([]);
  });

  it('accepts numeric ids and rejects rows without id or position', () => {
    expect(isJobEntry({ id: 7, position: 'x' })).toBe(true);
    expect(isJobEntry({ id: '', position: 'x' })).toBe(false);
    expect(isJobEntry({ id: '1' })).toBe(false);
    expect(isJobEntry({ position: 'x' })).toBe(false);
    expect(isJobEntry(null)).toBe(false);
    expect(isJobEntry([1])).toBe(false);
  });

  it('throws a blocked-classifiable error for a challenge page', () => {
    expect(() => parseFeedPayload('<html><title>Just a moment...</title></html>')).toThrow(/challenge/);
  });

  it('throws for other non-JSON and non-array bodies', () => {
    expect(() => parseFeedPayload('<html>oops</html>')).toThrow(/non-JSON/);
    expect(() => parseFeedPayload({ error: 'x' })).toThrow(/non-array/);
    expect(() => parseFeedPayload(null)).toThrow(/non-array/);
  });
});

describe('parseLegacyMode', () => {
  it.each<[string | undefined, string[]]>([
    [undefined, []],
    ['', []],
    ['false', []],
    ['off', []],
    ['true', ['search', 'text', 'urls', 'salary', 'location', 'ua']],
    ['ALL', ['search', 'text', 'urls', 'salary', 'location', 'ua']],
    ['ua', ['ua']],
    ['search', ['search']],
    [' text , salary ', ['text', 'salary']],
    ['urls location', ['urls', 'location']],
  ])('%p -> %j', (raw, expected) => {
    expect([...parseLegacyMode(raw).parts].sort()).toEqual([...expected].sort());
  });

  it('reports unknown parts', () => {
    const mode = parseLegacyMode('search,bogus');
    expect([...mode.parts]).toEqual(['search']);
    expect(mode.unknown).toEqual(['bogus']);
  });
});
