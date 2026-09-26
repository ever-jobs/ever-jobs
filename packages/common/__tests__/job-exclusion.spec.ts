import { ExclusionPreset, MAX_EXCLUSION_TERMS } from '@ever-jobs/models';
import {
  applyJobExclusions,
  compileJobExclusions,
  exclusionSpecFromInput,
  hasExclusionInput,
  matchJobExclusion,
  EXCLUSION_PRESET_TERMS,
  JobExclusionSpec,
} from '../src/utils/job-exclusion';

/**
 * Spec 1700 — post-scrape exclusion filters. Every fixture is synthetic: the
 * titles are paraphrases in the shapes a large public ATS board uses.
 */

interface J {
  id: string;
  title?: unknown;
  description?: unknown;
}

let seq = 0;
function job(title: unknown, description?: unknown): J {
  seq += 1;
  return { id: `j${seq}`, title, description };
}

function titlesKept(titles: string[], spec: JobExclusionSpec): string[] {
  return applyJobExclusions(titles.map((t) => job(t)), spec).kept.map((j) => j.title as string);
}

function isExcluded(title: string, spec: JobExclusionSpec, description?: string): boolean {
  return matchJobExclusion(job(title, description), compileJobExclusions(spec)) !== null;
}

const CLEARANCE: JobExclusionSpec = { presets: [ExclusionPreset.SECURITY_CLEARANCE] };

describe('applyJobExclusions — empty specs are a no-op (P1)', () => {
  const jobs = [job('Senior Engineer'), job('Analyst (TS/SCI)'), job('Lead Designer')];

  it.each<[string, JobExclusionSpec | undefined | null]>([
    ['undefined', undefined],
    ['null', null],
    ['{}', {}],
    ['empty titleTerms', { titleTerms: [] }],
    ['blank titleTerms', { titleTerms: ['   '] }],
    ['punctuation-only keywords', { keywords: ['***'] }],
    ['all lists empty', { titleTerms: [], keywords: [], presets: [] }],
  ])('%s keeps every job in order', (_label, spec) => {
    const out = applyJobExclusions(jobs, spec);
    expect(out.kept).toEqual(jobs);
    expect(out.kept).not.toBe(jobs);
    expect(out.excluded).toEqual([]);
    expect(out.metrics.excludedCount).toBe(0);
    expect(out.metrics.excludedRawCount).toBe(0);
  });

  it('reports why a blank term was ignored', () => {
    const out = applyJobExclusions(jobs, { titleTerms: ['   '], keywords: ['***'] });
    expect(out.metrics.ignoredTerms).toEqual([
      { term: '   ', reason: 'empty' },
      { term: '***', reason: 'empty' },
    ]);
  });
});

describe('case, accents and whole tokens (P2)', () => {
  it('is case-insensitive', () => {
    for (const t of ['SENIOR', 'Senior', 'senior']) {
      expect(isExcluded(`${t} Engineer`, { titleTerms: ['senior'] })).toBe(true);
      expect(isExcluded('Senior Engineer', { titleTerms: [t] })).toBe(true);
    }
  });

  it('is accent-insensitive', () => {
    expect(isExcluded('Señor Chef', { titleTerms: ['senor'] })).toBe(true);
    expect(isExcluded('Senor Chef', { titleTerms: ['Señor'] })).toBe(true);
    expect(isExcluded('İstanbul Office Lead', { titleTerms: ['istanbul'] })).toBe(true);
  });

  it('`sci` matches the token only', () => {
    expect(
      titlesKept(
        ['Research Scientist', 'Flight Sciences Engineer', 'Multidisciplinary Design Engineer', 'Analyst (TS/SCI)'],
        { titleTerms: ['sci'] },
      ),
    ).toEqual(['Research Scientist', 'Flight Sciences Engineer', 'Multidisciplinary Design Engineer']);
  });

  it('`poly` and `secret` do not match inside longer words', () => {
    expect(titlesKept(['Materials Engineer (Polymeric Ablatives)'], { titleTerms: ['poly'] })).toHaveLength(1);
    expect(titlesKept(['Executive Secretary'], { titleTerms: ['secret'] })).toHaveLength(1);
  });

  it('`lead` is a whole token; `lead*` is a prefix', () => {
    const titles = ['Senior Leadership Recruiter', 'Lead Hardware Engineer', 'Compliance Leader, APAC'];
    expect(titlesKept(titles, { titleTerms: ['lead'] })).toEqual([
      'Senior Leadership Recruiter',
      'Compliance Leader, APAC',
    ]);
    expect(titlesKept(titles, { titleTerms: ['lead*'] })).toEqual([]);
  });

  it('a prefix wildcard still needs a whole-token start', () => {
    expect(isExcluded('Misleading Title', { titleTerms: ['lead*'] })).toBe(false);
  });
});

describe('phrases', () => {
  it('`ts/sci` matches every separator spelling', () => {
    for (const t of ['Analyst TS/SCI', 'Analyst TS-SCI', 'Analyst ts / sci', 'Analyst TS SCI', 'Analyst TS//SCI']) {
      expect(isExcluded(t, { titleTerms: ['ts/sci'] })).toBe(true);
    }
  });

  it('does not match non-contiguous tokens', () => {
    expect(isExcluded('Security Operations Clearance Desk', { titleTerms: ['security clearance'] })).toBe(false);
    expect(isExcluded('Security Clearance Desk', { titleTerms: ['security clearance'] })).toBe(true);
  });

  it('a multi-token term can end in a prefix', () => {
    expect(isExcluded('Senior Leadership Coach', { titleTerms: ['senior lead*'] })).toBe(true);
    expect(isExcluded('Senior Engineer, Leadership', { titleTerms: ['senior lead*'] })).toBe(false);
  });
});

describe('terms are literal text, never a regex (P3)', () => {
  it('never throws on regex-looking terms', () => {
    const spec = { titleTerms: ['c++', 'c#', '(senior)', '.*', '(a+)+$', 'a{1,99999}', '[', '\\'] };
    expect(() => applyJobExclusions([job('Anything at all'), job('(a+)+$')], spec)).not.toThrow();
  });

  it('`c++` matches C++ only; `c#` matches C# only', () => {
    const titles = ['C++ Developer', 'C Developer', 'C# Developer'];
    expect(titlesKept(titles, { titleTerms: ['c++'] })).toEqual(['C Developer', 'C# Developer']);
    expect(titlesKept(titles, { titleTerms: ['c#'] })).toEqual(['C++ Developer', 'C Developer']);
  });

  it('`(senior)` is the word senior', () => {
    expect(isExcluded('Senior Engineer', { titleTerms: ['(senior)'] })).toBe(true);
  });

  it('stays linear on adversarial input', () => {
    const terms = Array.from({ length: 50 }, (_, i) => `${'a'.repeat(i + 1)} (a+)+$ a{1,${i}}`.slice(0, 90));
    const description = `${'a'.repeat(100_000)}!`;
    const started = Date.now();
    applyJobExclusions([job('Engineer', description)], { keywords: terms });
    applyJobExclusions([job('Engineer', 'a '.repeat(50_000))], { keywords: terms });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('abbreviations (aliases)', () => {
  it('`senior` drops Sr. and Snr; `sr` drops Senior', () => {
    expect(isExcluded('Sr. Engineer', { titleTerms: ['senior'] })).toBe(true);
    expect(isExcluded('Snr Engineer', { titleTerms: ['senior'] })).toBe(true);
    expect(isExcluded('Senior Engineer', { titleTerms: ['sr'] })).toBe(true);
    expect(isExcluded('Jr Analyst', { titleTerms: ['junior'] })).toBe(true);
  });

  it('`Sr.` does not end the clause, so a phrase spans it', () => {
    expect(isExcluded('Sr. Engineer', { titleTerms: ['senior engineer'] })).toBe(true);
  });
});

describe('field scope', () => {
  it('titleTerms ignore the description', () => {
    expect(isExcluded('Engineer', { titleTerms: ['polygraph'] }, 'Requires a polygraph.')).toBe(false);
  });

  it('keywords hit the description and report the field', () => {
    const m = matchJobExclusion(
      job('Engineer', 'You will need an active polygraph.'),
      compileJobExclusions({ keywords: ['polygraph'] }),
    );
    expect(m).toEqual({ term: 'polygraph', source: 'keywords', field: 'description' });
  });

  it('a title hit never reads the description', () => {
    const read = jest.fn(() => 'description text');
    const subject = { title: 'Polygraph Examiner' };
    Object.defineProperty(subject, 'description', { get: read });
    const m = matchJobExclusion(subject, compileJobExclusions({ keywords: ['polygraph'] }));
    expect(m).toEqual({ term: 'polygraph', source: 'keywords', field: 'title' });
    expect(read).not.toHaveBeenCalled();
  });

  it('title-only filters never read the description', () => {
    const read = jest.fn(() => 'Senior');
    const subject = { title: 'Engineer' };
    Object.defineProperty(subject, 'description', { get: read });
    expect(matchJobExclusion(subject, compileJobExclusions({ titleTerms: ['senior'] }))).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('treats null, undefined and non-string fields as empty', () => {
    const c = compileJobExclusions({ keywords: ['senior'] });
    expect(matchJobExclusion(job(null, undefined), c)).toBeNull();
    expect(matchJobExclusion(job(42, { html: 'senior' }), c)).toBeNull();
    expect(matchJobExclusion(null, c)).toBeNull();
  });
});

describe('HTML descriptions (P6)', () => {
  it('does not match tag or attribute names', () => {
    expect(isExcluded('Engineer', { keywords: ['senior'] }, '<p class="senior">Engineer</p>')).toBe(false);
  });

  it('decodes entities before matching', () => {
    expect(isExcluded('Analyst', { keywords: ['ts sci'] }, '&lt;li&gt;Active TS/SCI&lt;/li&gt;')).toBe(true);
    expect(isExcluded('R&amp;D Lead', { titleTerms: ['r&d'] })).toBe(true);
  });

  it('block tags are clause boundaries', () => {
    expect(isExcluded('Engineer', { keywords: ['sc cleared'] }, '<p>Office in SC</p><p>Cleared staff welcome</p>')).toBe(
      false,
    );
  });

  it('keeps a literal `<` that is not a tag', () => {
    expect(isExcluded('Engineer', { keywords: ['senior'] }, 'team size < 10, senior role')).toBe(true);
  });

  it('the tag scan is linear on unclosed input', () => {
    const started = Date.now();
    applyJobExclusions([job('Engineer', '<'.repeat(50_000))], { keywords: ['senior'] });
    applyJobExclusions([job('Engineer', '<a'.repeat(25_000))], { keywords: ['senior'] });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('negated mentions (P4) and clause boundaries (P5)', () => {
  it.each([
    'No clearance required',
    'Clearance: not required',
    'This role does not require a security clearance.',
    'Non-clearance role',
    'A security clearance is not needed.',
    "A security clearance isn't required.",
    'Security clearance: none',
  ])('keeps "%s"', (description) => {
    expect(isExcluded('Engineer', CLEARANCE, description)).toBe(false);
  });

  it('keeps a title with a negated mention', () => {
    expect(isExcluded('Software Engineer (No Clearance)', { titleTerms: ['clearance'] })).toBe(false);
  });

  it('a negation in one clause does not protect the next', () => {
    const m = matchJobExclusion(
      job('Engineer', 'No polygraph. Active Secret clearance required.'),
      compileJobExclusions(CLEARANCE),
    );
    expect(m).toEqual({ term: 'secret clearance', source: 'preset:security_clearance', field: 'description' });
    expect(isExcluded('Engineer', CLEARANCE, 'No remote work. TS/SCI required.')).toBe(true);
  });

  it('a phrase never crosses a sentence boundary', () => {
    expect(isExcluded('Engineer', CLEARANCE, 'Greenville, SC. Cleared candidates preferred.')).toBe(false);
  });

  it('`.` inside a token is not a boundary', () => {
    expect(isExcluded('Node.js Engineer', { titleTerms: ['node.js'] })).toBe(true);
  });
});

describe('scripts without word separators (P8)', () => {
  it('matches a Han term inside a longer run', () => {
    expect(isExcluded('高级软件工程师', { titleTerms: ['工程师'] })).toBe(true);
    expect(isExcluded('产品经理', { titleTerms: ['工程师'] })).toBe(false);
  });

  it('matches a Thai term through the substring path', () => {
    expect(isExcluded('วิศวกรซอฟต์แวร์อาวุโส', { titleTerms: ['อาวุโส'] })).toBe(true);
  });
});

describe('security_clearance preset', () => {
  // 40 synthetic titles in the shapes a defence-sector ATS board uses.
  const dropped = [
    'Software Engineer (Active Clearance)',
    'Mission Systems Engineer (Active Clearance)',
    'Test Engineer - Clearance Eligible',
    'Program Manager (Secret Clearance)',
    'Security Clearance Specialist',
    'Analyst, TS/SCI',
    'Network Engineer - TS/SCI with Polygraph',
    'Top Secret Cleared Technician',
    'Facility Security Officer, DoD Clearance',
    'Integration Engineer (SC Cleared)',
    'Platform Engineer, DV Cleared',
    'Field Engineer - NV1',
    'Operator (Public Trust)',
    'Radar Engineer (Clearance Eligibility Required)',
  ];
  const kept = [
    'Research Scientist',
    'Flight Sciences Engineer',
    'Materials Engineer (Polymeric Ablatives)',
    'Executive Secretary',
    'Multidisciplinary Design Engineer',
    'Senior Leadership Recruiter',
    'Product Designer',
    'Data Scientist, Autonomy',
    'Supply Chain Planner',
    'Mechanical Engineer II',
    'Technician, Composites',
    'Recruiting Coordinator',
    'Frontend Engineer',
    'Site Reliability Engineer',
    'Payroll Specialist',
    'Controls Engineer',
    'Manufacturing Engineer, Night Shift',
    'Quality Inspector',
    'Office Manager',
    'Customer Success Lead',
    'Firmware Engineer',
    'Embedded Software Engineer (No Clearance Required)',
    'Tax Analyst',
    'Legal Counsel',
    'Scientific Programmer',
    'Secretarial Assistant',
  ];

  it('drops every clearance-shaped title and keeps the lookalikes', () => {
    const jobs = [...dropped, ...kept].map((t) => job(t));
    expect(jobs).toHaveLength(40);
    const out = applyJobExclusions(jobs, CLEARANCE);
    expect(out.excluded.map((e) => e.job.title)).toEqual(dropped);
    expect(out.kept.map((j) => j.title)).toEqual(kept);
  });

  it('byTerm counts add up to excludedRawCount', () => {
    const out = applyJobExclusions([...dropped, ...kept].map((t) => job(t)), CLEARANCE);
    const sum = out.metrics.byTerm.reduce((acc, t) => acc + t.count, 0);
    expect(sum).toBe(out.metrics.excludedRawCount);
    expect(out.metrics.excludedCount).toBe(dropped.length);
    for (const row of out.metrics.byTerm) expect(row.source).toBe('preset:security_clearance');
  });

  it('matches a description that phrases the requirement in words', () => {
    expect(
      isExcluded('Engineer', CLEARANCE, 'Must hold a Top Secret security clearance with Counterintelligence Polygraph.'),
    ).toBe(true);
  });

  it('has no bare sci, poly or secret term', () => {
    const terms = EXCLUSION_PRESET_TERMS[ExclusionPreset.SECURITY_CLEARANCE];
    for (const bad of ['sci', 'poly', 'secret', 'clearance']) expect(terms).not.toContain(bad);
  });

  it('ignores an unknown preset instead of throwing', () => {
    const out = applyJobExclusions([job('Engineer')], { presets: ['nope'] });
    expect(out.kept).toHaveLength(1);
    expect(out.metrics.ignoredTerms).toEqual([{ term: 'nope', reason: 'unknown_preset' }]);
  });
});

describe('limits', () => {
  it(`reports terms past the ${MAX_EXCLUSION_TERMS}-term cap as over_limit`, () => {
    const terms = Array.from({ length: MAX_EXCLUSION_TERMS + 1 }, (_, i) => `term${i}`);
    const c = compileJobExclusions({ titleTerms: terms });
    expect(c.ignored).toEqual([{ term: `term${MAX_EXCLUSION_TERMS}`, reason: 'over_limit' }]);
    expect(c.termCount).toBe(MAX_EXCLUSION_TERMS);
  });

  it('reports a short prefix, too many tokens and an over-long term', () => {
    const c = compileJobExclusions({
      titleTerms: ['a*', 'se*', 'one two three four five six seven eight nine', 'x'.repeat(101)],
    });
    expect(c.ignored).toEqual([
      { term: 'a*', reason: 'prefix_too_short' },
      { term: 'se*', reason: 'prefix_too_short' },
      { term: 'one two three four five six seven eight nine', reason: 'too_many_tokens' },
      { term: 'x'.repeat(100), reason: 'too_long' },
    ]);
    expect(c.active).toBe(false);
  });

  it('de-duplicates identical token sequences', () => {
    const c = compileJobExclusions({ titleTerms: ['TS/SCI', 'ts sci', 'ts-sci'] });
    expect(c.termCount).toBe(1);
  });
});

describe('determinism', () => {
  it('reports the earliest match by text position', () => {
    const c = compileJobExclusions({ titleTerms: ['principal', 'lead'] });
    expect(matchJobExclusion(job('Lead Principal Engineer'), c)?.term).toBe('lead');
    expect(matchJobExclusion(job('Principal Lead Engineer'), c)?.term).toBe('principal');
  });

  it('gives the same output for the same input', () => {
    const jobs = ['Lead Engineer', 'Staff Engineer', 'Principal Engineer', 'Engineer'].map((t) => job(t));
    const spec = { titleTerms: ['lead', 'staff', 'principal'] };
    expect(applyJobExclusions(jobs, spec)).toEqual(applyJobExclusions(jobs, spec));
  });

  it('accepts a pre-compiled spec', () => {
    const c = compileJobExclusions({ titleTerms: ['lead'] });
    expect(applyJobExclusions([job('Lead'), job('Staff')], c).kept.map((j) => j.title)).toEqual(['Staff']);
  });
});

describe('input helpers', () => {
  it('exclusionSpecFromInput maps the DTO fields', () => {
    expect(
      exclusionSpecFromInput({
        excludeTitleTerms: ['a'],
        excludeKeywords: ['b'],
        excludePresets: [ExclusionPreset.SECURITY_CLEARANCE],
      }),
    ).toEqual({ titleTerms: ['a'], keywords: ['b'], presets: ['security_clearance'] });
    expect(exclusionSpecFromInput(undefined)).toEqual({
      titleTerms: undefined,
      keywords: undefined,
      presets: undefined,
    });
  });

  it('hasExclusionInput is true for any supplied field, even an empty one', () => {
    expect(hasExclusionInput(undefined)).toBe(false);
    expect(hasExclusionInput({})).toBe(false);
    expect(hasExclusionInput({ excludeTitleTerms: null, excludeKeywords: undefined })).toBe(false);
    expect(hasExclusionInput({ excludeTitleTerms: [] })).toBe(true);
    expect(hasExclusionInput({ excludePresets: ['security_clearance'] })).toBe(true);
  });
});
