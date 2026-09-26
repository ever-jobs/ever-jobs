/**
 * Canonical job-type vocabulary; values are stable wire strings.
 *
 * The enum is append-only: new members go at the end so every existing value (and the
 * OpenAPI enum order) stays put. Localised labels resolve through {@link getJobTypeFromString}
 * (one field / chip) and {@link getJobTypesFromString} (a composite label such as
 * "CDI, Temps plein").
 */
export enum JobType {
  FULL_TIME = 'fulltime',
  PART_TIME = 'parttime',
  CONTRACT = 'contract',
  TEMPORARY = 'temporary',
  INTERNSHIP = 'internship',
  PER_DIEM = 'perdiem',
  NIGHTS = 'nights',
  OTHER = 'other',
  SUMMER = 'summer',
  VOLUNTEER = 'volunteer',
  /**
   * Open-ended employment (FR CDI, DE unbefristet, UK/AU "Permanent"). This is the duration
   * axis, orthogonal to hours: a source that states both emits it next to FULL_TIME/PART_TIME.
   */
  PERMANENT = 'permanent',
  /**
   * Work-study / apprenticeship contracts (FR alternance, apprentissage, professionnalisation;
   * DE Ausbildung; UK apprenticeships). A paid contract with training, not a short internship.
   */
  APPRENTICESHIP = 'apprenticeship',
}

/**
 * Canonical lookup key for a job-type label or alias.
 *
 * NFD, then the Latin combining-diacritic block (U+0300–U+036F) is dropped, then NFC,
 * lower-case, and finally whitespace, hyphens and dashes (U+2010–U+2015), `_`, `.`,
 * apostrophes (`'`, U+2019, U+02BC), `/` and parentheses are removed. `%` is kept, so the
 * Swiss `100%` alias still works. Hangul syllables recompose under NFC and non-Latin letters
 * such as `ł` or `ı` are base letters, so non-Latin aliases keep their identity.
 *
 * The same function keys both the alias tables and every input, so an alias can be written
 * in its natural spelling (`'temps partiel'`, `'intérim'`).
 */
export function normalizeJobTypeKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\-‐-―_.'’ʼ\/()]+/g, '');
}

/**
 * Extended aliases for multilingual job type matching.
 *
 * Aliases may be written in natural spelling: each one is keyed through
 * {@link normalizeJobTypeKey} when the lookup index is built. The index is built once at
 * module load, so edits made to this object at runtime are not seen by the resolvers.
 * Every member lists its own wire value (the self-alias invariant, enforced by the unit suite).
 */
export const JOB_TYPE_ALIASES: Record<JobType, string[]> = {
  [JobType.FULL_TIME]: [
    'fulltime', 'períodointegral', 'estágio/trainee', 'cunormăîntreagă',
    'tiempocompleto', 'vollzeit', 'voltijds', 'tempointegral', '全职',
    'plnýúvazek', 'fuldtid', 'دوامكامل', 'kokopäivätyö', 'tempsplein',
    'πλήρηςαπασχόληση', 'teljesmunkaidő', 'tempopieno', 'heltid',
    'jornadacompleta', 'pełnyetat', '정규직', '100%', '全職', 'งานประจำ',
    'tamzamanlı', 'повназайнятість', 'toànthờigian',
    // Spec 1697 additions (natural spelling).
    'temps complet',
  ],
  [JobType.PART_TIME]: [
    'parttime', 'teilzeit', 'částečnýúvazek', 'deltid',
    // Spec 1697 additions: the part-time counterparts of the FULL_TIME languages above.
    'temps partiel', 'tiempo parcial', 'jornada parcial', 'media jornada', 'deeltijd',
    'deeltijds', 'tempo parziale', 'tempo parcial', 'meio período', 'részmunkaidő',
    'osa-aikatyö', 'niepełny etat', 'μερική απασχόληση', 'half time', '兼职', '兼職',
    '파트타임', 'bán thời gian',
  ],
  [JobType.CONTRACT]: [
    'contract', 'contractor',
    // Spec 1697 additions: fixed-term contracts and freelancing share this bucket.
    'cdd', 'contrat à durée déterminée', 'fixed term', 'fixed-term contract', 'befristet',
    'freelance', 'freelancer', 'indépendant', 'self-employed', 'auto-entrepreneur',
    'contract to hire', 'contrato temporal',
  ],
  [JobType.TEMPORARY]: [
    'temporary',
    // Spec 1697 additions.
    'temp', 'interim', 'mission intérimaire', 'travail temporaire', 'seasonal', 'saisonnier',
    'contrat saisonnier', 'zeitarbeit', 'uitzendwerk', 'tijdelijk', 'temporal',
  ],
  [JobType.INTERNSHIP]: [
    'internship', 'prácticas', 'ojt(onthejobtraining)', 'praktikum', 'praktik',
    // Spec 1697 additions. `stage` is locale-scoped: see JOB_TYPE_LOCALE_ALIASES.
    'intern', 'stagiaire', 'stagiair', 'tirocinio', 'estágio', 'pasantía',
  ],
  [JobType.PER_DIEM]: ['perdiem'],
  [JobType.NIGHTS]: ['nights'],
  [JobType.OTHER]: ['other'],
  [JobType.SUMMER]: ['summer'],
  [JobType.VOLUNTEER]: ['volunteer'],
  [JobType.PERMANENT]: [
    'permanent', 'permanent contract', 'cdi', 'contrat à durée indéterminée', 'unbefristet',
    'festanstellung', 'vast contract', 'contrato indefinido', 'indefinido',
    'tempo indeterminato',
  ],
  [JobType.APPRENTICESHIP]: [
    'apprenticeship', 'apprentice', 'alternance', 'apprentissage', "contrat d'apprentissage",
    'professionnalisation', 'contrat de professionnalisation', 'cont. professionnalisation',
    'ausbildung', 'apprendistato', 'aprendiz', 'leerlingplaats',
  ],
};

/**
 * Aliases that are only trusted for text in a specific language, keyed by the primary
 * language subtag. `stage` is "internship" in French, Dutch and Italian but an ordinary
 * English word ("early-stage startup"), so it resolves only when the caller passes a
 * matching `{ locale }`. The global table is consulted first, then the locale table.
 */
export const JOB_TYPE_LOCALE_ALIASES: Readonly<
  Record<string, Partial<Record<JobType, readonly string[]>>>
> = {
  fr: { [JobType.INTERNSHIP]: ['stage'] },
  nl: { [JobType.INTERNSHIP]: ['stage'] },
  it: { [JobType.INTERNSHIP]: ['stage'] },
};

/** How a value handed to the resolvers should be trusted. */
export interface JobTypeLookupOptions {
  /**
   * BCP-47 language of the source text (e.g. `'fr'`, `'fr-FR'`, `'fr_BE'`). Enables the
   * matching {@link JOB_TYPE_LOCALE_ALIASES} table. The primary subtag is compared
   * case-insensitively.
   */
  locale?: string | null;
  /**
   * `'label'` (default): the value is a whole employment-type field or chip.
   * `'token'`: the value is a word or n-gram scanned out of prose; the aliases in
   * {@link JOB_TYPE_PROSE_AMBIGUOUS} are ignored.
   */
  mode?: 'label' | 'token';
}

/**
 * Normalised aliases that are only trusted as a whole label, never as a word scanned out of
 * prose: "permanent residency", "a temp-to-perm role", "interim results", "seasonal flu",
 * "temporal resolution", "a vast contract portfolio", "and other perks".
 */
export const JOB_TYPE_PROSE_AMBIGUOUS: ReadonlySet<string> = new Set(
  ['permanent', 'temp', 'interim', 'seasonal', 'other', 'temporal', 'vast contract'].map(
    normalizeJobTypeKey,
  ),
);

/**
 * Environment variable read by the prose-scanning plugins (via {@link jobTypeScanOptions}).
 * Unset or `token`: scanned words resolve in token mode. `label`: the pre-Spec-1697
 * behaviour, where every scanned word is trusted like a whole label.
 */
export const JOB_TYPE_SCAN_MODE_ENV = 'EVER_JOBS_JOB_TYPE_SCAN_MODE';

/**
 * Lookup options for a plugin that scans words or n-grams out of prose. Pure: the caller
 * passes its environment (normally `process.env`).
 */
export function jobTypeScanOptions(
  env?: Readonly<Record<string, string | undefined>> | null,
): JobTypeLookupOptions {
  const raw = env?.[JOB_TYPE_SCAN_MODE_ENV];
  const mode = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return { mode: mode === 'label' ? 'label' : 'token' };
}

/** A normalised key claimed by aliases of more than one member. */
export interface JobTypeAliasCollision {
  /** The shared normalised key. */
  key: string;
  /** The members claiming it, in the order the index sees them; the first one wins. */
  types: JobType[];
  /** `null` for the global table; else the locale whose table, read after the global one, collides. */
  locale: string | null;
}

type AliasTable = Partial<Record<JobType, readonly string[]>>;

function buildIndex(
  table: AliasTable,
  claims?: Map<string, JobType[]>,
): Map<string, JobType> {
  const index = new Map<string, JobType>();
  for (const [jobType, aliases] of Object.entries(table) as [JobType, readonly string[]][]) {
    for (const alias of aliases ?? []) {
      const key = normalizeJobTypeKey(alias);
      if (!key) continue;
      if (!index.has(key)) index.set(key, jobType);
      if (claims) {
        const owners = claims.get(key) ?? [];
        if (!owners.includes(jobType)) owners.push(jobType);
        claims.set(key, owners);
      }
    }
  }
  return index;
}

const GLOBAL_INDEX: ReadonlyMap<string, JobType> = buildIndex(JOB_TYPE_ALIASES);

const LOCALE_INDEX: ReadonlyMap<string, ReadonlyMap<string, JobType>> = new Map(
  Object.entries(JOB_TYPE_LOCALE_ALIASES).map(
    ([locale, table]) => [locale.toLowerCase(), buildIndex(table)] as const,
  ),
);

/**
 * Report every normalised key that two different members claim, in the global table and
 * in each locale table read together with the global one. Lookups never throw on a
 * collision (the first member wins); the unit suite asserts this returns `[]`.
 */
export function findJobTypeAliasCollisions(
  aliases: AliasTable = JOB_TYPE_ALIASES,
  localeAliases: Readonly<Record<string, AliasTable>> = JOB_TYPE_LOCALE_ALIASES,
): JobTypeAliasCollision[] {
  const collisions: JobTypeAliasCollision[] = [];
  const globalClaims = new Map<string, JobType[]>();
  buildIndex(aliases, globalClaims);
  for (const [key, types] of globalClaims) {
    if (types.length > 1) collisions.push({ key, types, locale: null });
  }
  for (const [locale, table] of Object.entries(localeAliases)) {
    const localeClaims = new Map<string, JobType[]>();
    buildIndex(table, localeClaims);
    for (const [key, localTypes] of localeClaims) {
      const types = [...(globalClaims.get(key) ?? [])];
      for (const jobType of localTypes) {
        if (!types.includes(jobType)) types.push(jobType);
      }
      if (types.length > 1) collisions.push({ key, types, locale });
    }
  }
  return collisions;
}

function lookupOptions(options: unknown): JobTypeLookupOptions {
  // Defensive: `.map(getJobTypeFromString)` passes the array index as the second argument.
  return typeof options === 'object' && options !== null ? (options as JobTypeLookupOptions) : {};
}

function primaryLanguage(locale: string | null | undefined): string | null {
  if (typeof locale !== 'string') return null;
  const primary = locale.trim().split(/[-_]/)[0].toLowerCase();
  return primary || null;
}

/**
 * Resolve one raw employment-type label to a JobType. Null-safe: non-strings, empty strings
 * and separator-only strings give `null`. Never throws.
 *
 * @param value   A whole label (`'Full-Time'`, `'FULL_TIME'`, `'CDI'`, `'Temps partiel'`), or,
 *                with `{ mode: 'token' }`, a word / n-gram scanned out of prose.
 * @param options Optional locale and mode, see {@link JobTypeLookupOptions}.
 */
export function getJobTypeFromString(
  value: string | null | undefined,
  options?: JobTypeLookupOptions,
): JobType | null {
  if (typeof value !== 'string') return null;
  const opts = lookupOptions(options);
  const key = normalizeJobTypeKey(value);
  if (!key) return null;
  if (opts.mode === 'token' && JOB_TYPE_PROSE_AMBIGUOUS.has(key)) return null;
  const hit = GLOBAL_INDEX.get(key);
  if (hit) return hit;
  const lang = primaryLanguage(opts.locale);
  return (lang && LOCALE_INDEX.get(lang)?.get(key)) || null;
}

/**
 * Labels longer than this are prose, not a composite label: {@link getJobTypesFromString}
 * only tries them as one whole value.
 */
export const JOB_TYPE_COMPOSITE_MAX_LENGTH = 256;

/** Longest alias n-gram (in words) tried when covering an unresolved segment. */
const MAX_NGRAM_WORDS = 4;

/** Splits a composite label into facets. Plain character class: linear time. */
const PRIMARY_SEPARATORS = /[,;|+&•·]/;

/** A word that is only a dash separates facets ("CDI - Temps plein"). */
const DASH_WORD = /^[-‐-―]+$/;

/** Stand-alone conjunctions that separate facets ("Full-time or Part-time"), normalised. */
const CONJUNCTION_WORDS: ReadonlySet<string> = new Set([
  'et', 'and', 'ou', 'or', 'und', 'oder', 'y', 'o', 'e',
]);

/**
 * Words that may sit next to an alias without making a segment prose: durations
 * ("24 Mois", "35h", "6 months") and short connectors ("CDD de 6 mois", "CDI à temps plein").
 * Stored normalised (accents stripped, lower-case).
 */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  // Duration units.
  'h', 'hr', 'hrs', 'hour', 'hours', 'heure', 'heures', 'jour', 'jours', 'day', 'days',
  'semaine', 'semaines', 'week', 'weeks', 'mois', 'month', 'months', 'an', 'ans', 'annee',
  'annees', 'year', 'years', 'monat', 'monate', 'woche', 'wochen', 'jahr', 'jahre', 'mes',
  'meses', 'semana', 'semanas', 'mese', 'mesi', 'settimana', 'settimane', 'dia', 'dias',
  // Connectors.
  'a', 'de', 'd', 'du', 'des', 'of', 'for', 'von', 'fur', 'van', 'di', 'da', 'del',
]);

/** A number, optionally with an hours suffix ("12", "6,5", "35h", "40hrs"). Keys are normalised. */
const NUMERIC_WORD = /^\d+(?:,\d+)?(?:h|hr|hrs)?$/;

function isNoiseWord(key: string): boolean {
  return key === '' || NUMERIC_WORD.test(key) || NOISE_WORDS.has(key);
}

/**
 * Resolve a segment's words greedily, longest alias n-gram first. The hits count only when
 * every word is covered by a hit or is a noise word, so "permanent residency" (where
 * `residency` is uncovered) yields nothing.
 */
function coverWords(words: readonly string[], opts: JobTypeLookupOptions): JobType[] {
  const hits: JobType[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = 0;
    for (let n = Math.min(MAX_NGRAM_WORDS, words.length - i); n >= 1; n--) {
      const hit = getJobTypeFromString(words.slice(i, i + n).join(' '), opts);
      if (hit) {
        hits.push(hit);
        matched = n;
        break;
      }
    }
    if (matched > 0) {
      i += matched;
      continue;
    }
    if (!isNoiseWord(normalizeJobTypeKey(words[i]))) return [];
    i++;
  }
  return hits;
}

/** Split a primary segment on `/`, stand-alone dashes and conjunctions into word runs. */
function secondarySegments(segment: string): string[][] {
  const runs: string[][] = [];
  for (const piece of segment.replace(/[()]/g, ' ').split('/')) {
    let run: string[] = [];
    for (const word of piece.split(/\s+/)) {
      if (!word) continue;
      if (DASH_WORD.test(word) || CONJUNCTION_WORDS.has(normalizeJobTypeKey(word))) {
        if (run.length > 0) runs.push(run);
        run = [];
        continue;
      }
      run.push(word);
    }
    if (run.length > 0) runs.push(run);
  }
  return runs;
}

/**
 * Resolve a composite label that combines several facets ("CDI, Temps plein",
 * "Full-time, Permanent", "Contract/Temp", "Apprentissage - 24 Mois") to every JobType it
 * states, in order and without duplicates. Runs in label mode unless the options say otherwise.
 *
 * 1. The whole value is tried first, so multi-word aliases (`contrat à durée indéterminée`,
 *    `estágio/trainee`) stay intact.
 * 2. Otherwise it is split on `, ; | + & • ·`, and each segment is tried whole.
 * 3. An unresolved segment is split on `/`, stand-alone dashes and conjunctions
 *    (`et and ou or und oder y o e`), with parentheses treated as spaces; each run is tried
 *    whole, then covered word by word (longest n-gram first, up to 4 words). A run's hits are
 *    kept only when every word is an alias or a noise word (a number, `35h`, a duration unit or
 *    a short connector).
 *
 * Null-safe and never throws; returns `null` when nothing matched. A value longer than
 * {@link JOB_TYPE_COMPOSITE_MAX_LENGTH} is only tried whole.
 */
export function getJobTypesFromString(
  value: string | null | undefined,
  options?: JobTypeLookupOptions,
): JobType[] | null {
  if (typeof value !== 'string') return null;
  const opts = lookupOptions(options);
  const whole = getJobTypeFromString(value, opts);
  if (whole) return [whole];
  if (value.length > JOB_TYPE_COMPOSITE_MAX_LENGTH) return null;

  const out: JobType[] = [];
  const add = (jobType: JobType): void => {
    if (!out.includes(jobType)) out.push(jobType);
  };

  for (const segment of value.split(PRIMARY_SEPARATORS)) {
    const segmentHit = getJobTypeFromString(segment, opts);
    if (segmentHit) {
      add(segmentHit);
      continue;
    }
    for (const run of secondarySegments(segment)) {
      const runHit = getJobTypeFromString(run.join(' '), opts);
      if (runHit) {
        add(runHit);
        continue;
      }
      for (const hit of coverWords(run, opts)) add(hit);
    }
  }
  return out.length > 0 ? out : null;
}
