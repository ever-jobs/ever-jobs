import {
  JOB_TYPE_ALIASES,
  JOB_TYPE_COMPOSITE_MAX_LENGTH,
  JOB_TYPE_LOCALE_ALIASES,
  JOB_TYPE_PROSE_AMBIGUOUS,
  JOB_TYPE_SCAN_MODE_ENV,
  JobType,
  findJobTypeAliasCollisions,
  getJobTypeFromString,
  getJobTypesFromString,
  jobTypeScanOptions,
  normalizeJobTypeKey,
} from '../src/enums/job-type.enum';

/**
 * Literal copy of the alias table and resolver as they stood before Spec 1697. Every input
 * the old resolver matched must still resolve to the same member.
 */
const LEGACY_ALIASES: Record<string, string[]> = {
  fulltime: [
    'fulltime', 'períodointegral', 'estágio/trainee', 'cunormăîntreagă',
    'tiempocompleto', 'vollzeit', 'voltijds', 'tempointegral', '全职',
    'plnýúvazek', 'fuldtid', 'دوامكامل', 'kokopäivätyö', 'tempsplein',
    'πλήρηςαπασχόληση', 'teljesmunkaidő', 'tempopieno', 'heltid',
    'jornadacompleta', 'pełnyetat', '정규직', '100%', '全職', 'งานประจำ',
    'tamzamanlı', 'повназайнятість', 'toànthờigian',
  ],
  parttime: ['parttime', 'teilzeit', 'částečnýúvazek', 'deltid'],
  contract: ['contract', 'contractor'],
  temporary: ['temporary'],
  internship: ['internship', 'prácticas', 'ojt(onthejobtraining)', 'praktikum', 'praktik'],
  perdiem: ['perdiem'],
  nights: ['nights'],
  other: ['other'],
  summer: ['summer'],
  volunteer: ['volunteer'],
};

function legacyGetJobTypeFromString(value: string): string | null {
  const normalized = value.toLowerCase().replace(/[\s-]/g, '');
  for (const [jobType, aliases] of Object.entries(LEGACY_ALIASES)) {
    if (aliases.includes(normalized)) return jobType;
  }
  return null;
}

describe('JobType enum', () => {
  it('appends PERMANENT and APPRENTICESHIP without changing existing wire values', () => {
    expect(Object.values(JobType)).toEqual([
      'fulltime', 'parttime', 'contract', 'temporary', 'internship', 'perdiem', 'nights',
      'other', 'summer', 'volunteer', 'permanent', 'apprenticeship',
    ]);
  });

  it('every member resolves to itself (self-alias invariant)', () => {
    for (const value of Object.values(JobType)) {
      expect(getJobTypeFromString(value)).toBe(value);
      expect(getJobTypeFromString(value.toUpperCase())).toBe(value);
    }
  });
});

describe('normalizeJobTypeKey', () => {
  it('strips separators, Latin diacritics and case', () => {
    expect(normalizeJobTypeKey('Temps  Partiel')).toBe('tempspartiel');
    expect(normalizeJobTypeKey('FULL_TIME')).toBe('fulltime');
    expect(normalizeJobTypeKey('Full–Time')).toBe('fulltime');
    expect(normalizeJobTypeKey("Contrat d’apprentissage")).toBe('contratdapprentissage');
    expect(normalizeJobTypeKey('Cont. professionnalisation')).toBe('contprofessionnalisation');
    expect(normalizeJobTypeKey('Intérim')).toBe('interim');
    expect(normalizeJobTypeKey('estágio/trainee')).toBe('estagiotrainee');
    expect(normalizeJobTypeKey('OJT (On the Job Training)')).toBe('ojtonthejobtraining');
  });

  it('keeps % and non-Latin letters', () => {
    expect(normalizeJobTypeKey('100 %')).toBe('100%');
    expect(normalizeJobTypeKey('정규직')).toBe('정규직');
    expect(normalizeJobTypeKey('pełny etat')).toBe('pełnyetat');
    expect(normalizeJobTypeKey('tam zamanlı')).toBe('tamzamanlı');
    expect(normalizeJobTypeKey('งานประจำ')).toBe('งานประจำ');
  });

  it('is idempotent and never empties an alias', () => {
    const tables = [JOB_TYPE_ALIASES, ...Object.values(JOB_TYPE_LOCALE_ALIASES)];
    for (const table of tables) {
      for (const aliases of Object.values(table)) {
        for (const alias of aliases ?? []) {
          const key = normalizeJobTypeKey(alias);
          expect(key).not.toBe('');
          expect(normalizeJobTypeKey(key)).toBe(key);
        }
      }
    }
  });
});

describe('getJobTypeFromString', () => {
  describe('legacy regression', () => {
    const legacyInputs: string[] = [];
    for (const aliases of Object.values(LEGACY_ALIASES)) {
      for (const alias of aliases) {
        legacyInputs.push(alias, alias.toUpperCase(), alias.charAt(0).toUpperCase() + alias.slice(1));
      }
    }
    legacyInputs.push(
      'Full-Time', 'Full Time', 'full time', 'Part Time', 'Part-time', 'PART-TIME', 'Per Diem',
      'per-diem', 'Contract', 'CONTRACTOR', 'Temporary', 'Internship', 'Nights', 'Other',
      'Summer', 'Volunteer', 'Temps plein', 'Tiempo completo', 'Vollzeit', 'Teilzeit',
      'Prácticas', 'Praktikum', 'Pełny etat', '100 %', 'Plný úvazek', 'Toàn thời gian',
      'Πλήρης απασχόληση', 'Estágio/Trainee', 'OJT (On the Job Training)', 'Heltid',
    );

    it.each(legacyInputs.filter((input) => legacyGetJobTypeFromString(input) !== null))(
      'still resolves %s to the same member',
      (input) => {
        expect(getJobTypeFromString(input)).toBe(legacyGetJobTypeFromString(input));
      },
    );

    it('the regression corpus is not vacuous', () => {
      const covered = legacyInputs.filter((input) => legacyGetJobTypeFromString(input) !== null);
      const aliasCount = Object.values(LEGACY_ALIASES).reduce((n, list) => n + list.length, 0);
      expect(aliasCount).toBe(44);
      expect(covered.length).toBeGreaterThan(aliasCount);
    });
  });

  it('has no alias collisions, globally or per locale', () => {
    expect(findJobTypeAliasCollisions()).toEqual([]);
  });

  it('the collision detector reports a planted collision (control)', () => {
    const dirty = {
      ...JOB_TYPE_ALIASES,
      [JobType.PART_TIME]: [...JOB_TYPE_ALIASES[JobType.PART_TIME], 'Full-Time'],
    };
    expect(findJobTypeAliasCollisions(dirty, {})).toEqual([
      { key: 'fulltime', types: [JobType.FULL_TIME, JobType.PART_TIME], locale: null },
    ]);
    expect(
      findJobTypeAliasCollisions(JOB_TYPE_ALIASES, { fr: { [JobType.SUMMER]: ['CDI'] } }),
    ).toEqual([{ key: 'cdi', types: [JobType.PERMANENT, JobType.SUMMER], locale: 'fr' }]);
  });

  it('resolves snake-case and upper-case tokens', () => {
    expect(getJobTypeFromString('full_time')).toBe(JobType.FULL_TIME);
    expect(getJobTypeFromString('FULL_TIME')).toBe(JobType.FULL_TIME);
    expect(getJobTypeFromString('part_time')).toBe(JobType.PART_TIME);
    expect(getJobTypeFromString('PER_DIEM')).toBe(JobType.PER_DIEM);
    expect(getJobTypeFromString('per_diem')).toBe(JobType.PER_DIEM);
  });

  it.each([
    ['CDI', JobType.PERMANENT],
    ['cdi', JobType.PERMANENT],
    ['Contrat à durée indéterminée', JobType.PERMANENT],
    ['Contrat a duree indeterminee', JobType.PERMANENT],
    ['Permanent', JobType.PERMANENT],
    ['Permanent Contract', JobType.PERMANENT],
    ['Unbefristet', JobType.PERMANENT],
    ['Festanstellung', JobType.PERMANENT],
    ['cdd', JobType.CONTRACT],
    ['CDD', JobType.CONTRACT],
    ['Contrat à durée déterminée', JobType.CONTRACT],
    ['Befristet', JobType.CONTRACT],
    ['Fixed-term', JobType.CONTRACT],
    ['Freelance', JobType.CONTRACT],
    ['Indépendant', JobType.CONTRACT],
    ['independant', JobType.CONTRACT],
    ['Self-employed', JobType.CONTRACT],
    ['Auto-entrepreneur', JobType.CONTRACT],
    ['Intérim', JobType.TEMPORARY],
    ['interim', JobType.TEMPORARY],
    ['Mission intérimaire', JobType.TEMPORARY],
    ['Travail temporaire', JobType.TEMPORARY],
    ['Saisonnier', JobType.TEMPORARY],
    ['Temp', JobType.TEMPORARY],
    ['Seasonal', JobType.TEMPORARY],
    ['Alternance', JobType.APPRENTICESHIP],
    ['Apprentissage', JobType.APPRENTICESHIP],
    ["Contrat d'apprentissage", JobType.APPRENTICESHIP],
    ['Contrat de professionnalisation', JobType.APPRENTICESHIP],
    ['Cont. professionnalisation', JobType.APPRENTICESHIP],
    ['Ausbildung', JobType.APPRENTICESHIP],
    ['Apprenticeship', JobType.APPRENTICESHIP],
    ['Stagiaire', JobType.INTERNSHIP],
    ['Intern', JobType.INTERNSHIP],
    ['Tirocinio', JobType.INTERNSHIP],
    ['Temps partiel', JobType.PART_TIME],
    ['TEMPS PARTIEL', JobType.PART_TIME],
    ['Tiempo parcial', JobType.PART_TIME],
    ['Deeltijd', JobType.PART_TIME],
    ['Tempo parziale', JobType.PART_TIME],
    ['Μερική απασχόληση', JobType.PART_TIME],
    ['兼职', JobType.PART_TIME],
    ['Temps complet', JobType.FULL_TIME],
    ['Temps plein', JobType.FULL_TIME],
  ])('resolves the EU contract label %s', (label, expected) => {
    expect(getJobTypeFromString(label)).toBe(expected);
  });

  describe('locale-scoped aliases', () => {
    it('resolves Stage only for fr, nl and it', () => {
      expect(getJobTypeFromString('Stage')).toBeNull();
      for (const locale of ['fr', 'fr-FR', 'FR', 'fr_BE', ' fr-CA ', 'nl', 'nl-BE', 'it', 'IT-it']) {
        expect(getJobTypeFromString('Stage', { locale })).toBe(JobType.INTERNSHIP);
      }
      for (const locale of ['en', 'en-GB', 'de', '', '  ', null, undefined]) {
        expect(getJobTypeFromString('Stage', { locale })).toBeNull();
      }
    });

    it('reads the global table before the locale table', () => {
      expect(getJobTypeFromString('CDI', { locale: 'fr' })).toBe(JobType.PERMANENT);
      expect(getJobTypeFromString('Full-Time', { locale: 'de' })).toBe(JobType.FULL_TIME);
    });
  });

  describe('token mode', () => {
    it.each([
      ['permanent', JobType.PERMANENT],
      ['temp', JobType.TEMPORARY],
      ['interim', JobType.TEMPORARY],
      ['seasonal', JobType.TEMPORARY],
      ['other', JobType.OTHER],
      ['temporal', JobType.TEMPORARY],
      ['vast contract', JobType.PERMANENT],
    ])('ignores the prose-ambiguous alias %s (label mode still resolves it)', (word, member) => {
      expect(getJobTypeFromString(word, { mode: 'token' })).toBeNull();
      expect(getJobTypeFromString(word)).toBe(member);
      expect(getJobTypeFromString(word, { mode: 'label' })).toBe(member);
    });

    it('keeps unambiguous aliases', () => {
      expect(getJobTypeFromString('internship', { mode: 'token' })).toBe(JobType.INTERNSHIP);
      expect(getJobTypeFromString('fulltime', { mode: 'token' })).toBe(JobType.FULL_TIME);
      expect(getJobTypeFromString('full time', { mode: 'token' })).toBe(JobType.FULL_TIME);
      expect(getJobTypeFromString('summer', { mode: 'token' })).toBe(JobType.SUMMER);
      expect(getJobTypeFromString('apprenticeship', { mode: 'token' })).toBe(JobType.APPRENTICESHIP);
    });

    it('never resolves stage in token mode without a locale', () => {
      expect(getJobTypeFromString('stage', { mode: 'token' })).toBeNull();
    });

    it('the ambiguous set is stored normalised', () => {
      for (const key of JOB_TYPE_PROSE_AMBIGUOUS) {
        expect(normalizeJobTypeKey(key)).toBe(key);
      }
    });
  });

  it('is null-safe and ignores a non-object options argument', () => {
    expect(getJobTypeFromString(null)).toBeNull();
    expect(getJobTypeFromString(undefined)).toBeNull();
    expect(getJobTypeFromString('')).toBeNull();
    expect(getJobTypeFromString('  - _ ')).toBeNull();
    expect(getJobTypeFromString(42 as unknown as string)).toBeNull();
    expect(getJobTypeFromString('Full-Time', 3 as unknown as undefined)).toBe(JobType.FULL_TIME);
    expect(['Full-Time', 'CDI'].map(getJobTypeFromString as (v: string, i: number) => JobType | null)).toEqual([
      JobType.FULL_TIME,
      JobType.PERMANENT,
    ]);
  });

  it('maps the public contract-type facet vocabulary of the French board index', () => {
    // Synthetic list of the facet keys seen on the index (probe 2026-09-24).
    const resolved: Record<string, JobType> = {
      full_time: JobType.FULL_TIME,
      part_time: JobType.PART_TIME,
      temporary: JobType.TEMPORARY,
      internship: JobType.INTERNSHIP,
      apprenticeship: JobType.APPRENTICESHIP,
      freelance: JobType.CONTRACT,
      volunteer: JobType.VOLUNTEER,
      other: JobType.OTHER,
    };
    for (const [key, expected] of Object.entries(resolved)) {
      expect(getJobTypeFromString(key, { locale: 'fr' })).toBe(expected);
    }
    for (const knownUnmapped of ['vie', 'graduate_program', 'idv']) {
      expect(getJobTypeFromString(knownUnmapped, { locale: 'fr' })).toBeNull();
    }
  });
});

describe('getJobTypesFromString', () => {
  it.each<[string, { locale?: string; mode?: 'label' | 'token' } | undefined, JobType[] | null]>([
    ['CDI, Temps plein', undefined, [JobType.PERMANENT, JobType.FULL_TIME]],
    ['CDI - Temps plein', undefined, [JobType.PERMANENT, JobType.FULL_TIME]],
    ['Temps plein - CDI', undefined, [JobType.FULL_TIME, JobType.PERMANENT]],
    ['CDI – Temps partiel', undefined, [JobType.PERMANENT, JobType.PART_TIME]],
    ['Full-time, Permanent', undefined, [JobType.FULL_TIME, JobType.PERMANENT]],
    ['Permanent Full Time', undefined, [JobType.PERMANENT, JobType.FULL_TIME]],
    ['Contract/Temp', undefined, [JobType.CONTRACT, JobType.TEMPORARY]],
    ['Part-time / Temporary', undefined, [JobType.PART_TIME, JobType.TEMPORARY]],
    ['Full-time or Part-time', undefined, [JobType.FULL_TIME, JobType.PART_TIME]],
    ['Tiempo completo y tiempo parcial', undefined, [JobType.FULL_TIME, JobType.PART_TIME]],
    ['Apprentissage - 24 Mois', undefined, [JobType.APPRENTICESHIP]],
    ['Apprentissage 24 Mois', undefined, [JobType.APPRENTICESHIP]],
    ['Contrat de professionnalisation 12 mois', undefined, [JobType.APPRENTICESHIP]],
    ['CDD (6 mois)', undefined, [JobType.CONTRACT]],
    ['CDD 35h', undefined, [JobType.CONTRACT]],
    ['CDD de 6 mois', undefined, [JobType.CONTRACT]],
    ['CDI à temps plein', undefined, [JobType.PERMANENT, JobType.FULL_TIME]],
    ['Stage - 4 Mois', { locale: 'fr' }, [JobType.INTERNSHIP]],
    ['Stage 6 mois', { locale: 'fr' }, [JobType.INTERNSHIP]],
    ['Stage', undefined, null],
    ['Freelance / Indépendant', undefined, [JobType.CONTRACT]],
    ['Contractor - W2', undefined, [JobType.CONTRACT]],
    ['Full Time (40 hours)', undefined, [JobType.FULL_TIME]],
    ['Summer Internship', undefined, [JobType.SUMMER, JobType.INTERNSHIP]],
    ['Permanent Contract', undefined, [JobType.PERMANENT]],
    ['Contrat à durée indéterminée', undefined, [JobType.PERMANENT]],
    ['U.S. citizenship or permanent residency', undefined, null],
    ['early stage startup', { locale: 'fr' }, null],
    ['Estágio/Trainee', undefined, [JobType.FULL_TIME]],
    ['CDI; CDI', undefined, [JobType.PERMANENT]],
    ['Permanent, Full-time', { mode: 'token' }, [JobType.FULL_TIME]],
  ])('%s %j -> %j', (label, options, expected) => {
    expect(getJobTypesFromString(label, options)).toEqual(expected);
  });

  it('is null-safe', () => {
    expect(getJobTypesFromString(null)).toBeNull();
    expect(getJobTypesFromString(undefined)).toBeNull();
    expect(getJobTypesFromString('')).toBeNull();
    expect(getJobTypesFromString(' , / - ')).toBeNull();
    expect(getJobTypesFromString(7 as unknown as string)).toBeNull();
  });

  it('only tries an over-long value whole', () => {
    const padded = `CDI, ${'x'.repeat(JOB_TYPE_COMPOSITE_MAX_LENGTH)}`;
    expect(getJobTypesFromString(padded)).toBeNull();
    expect(getJobTypesFromString(`CDI, Temps plein${' '.repeat(10)}`)).toEqual([
      JobType.PERMANENT,
      JobType.FULL_TIME,
    ]);
  });

  it('stays fast on pathological separator runs', () => {
    const nasty = `${' '.repeat(JOB_TYPE_COMPOSITE_MAX_LENGTH - 2)}-x`;
    const start = Date.now();
    expect(getJobTypesFromString(nasty)).toBeNull();
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('jobTypeScanOptions', () => {
  it('defaults to token mode', () => {
    expect(jobTypeScanOptions(undefined)).toEqual({ mode: 'token' });
    expect(jobTypeScanOptions(null)).toEqual({ mode: 'token' });
    expect(jobTypeScanOptions({})).toEqual({ mode: 'token' });
    expect(jobTypeScanOptions({ [JOB_TYPE_SCAN_MODE_ENV]: 'token' })).toEqual({ mode: 'token' });
    expect(jobTypeScanOptions({ [JOB_TYPE_SCAN_MODE_ENV]: 'bogus' })).toEqual({ mode: 'token' });
  });

  it('restores the legacy label behaviour when the env var says label', () => {
    expect(JOB_TYPE_SCAN_MODE_ENV).toBe('EVER_JOBS_JOB_TYPE_SCAN_MODE');
    expect(jobTypeScanOptions({ [JOB_TYPE_SCAN_MODE_ENV]: ' LABEL ' })).toEqual({ mode: 'label' });
  });
});
