import type {
  CareerLevel,
  CareerLevelConfidence,
  CareerLevelInput,
  CareerLevelVerdict,
} from '@ever-jobs/models';

/**
 * Deterministic career-level rules (Spec 1730, contract C7).
 *
 * Everything here is a pure function of its input: no I/O, no clock, no randomness. The rule
 * tables are documented in `.specify/specs/1730-career-level-classifier/spec.md` §7.5 — keep the
 * two in sync when a rule changes.
 *
 * Evidence is ranked: the **title** decides; **structured source fields** (`jobType`,
 * `employmentType`, `jobLevel`, `experienceRange`) decide only when the title is silent; the
 * **description** decides only when both are silent. Lower-ranked evidence otherwise just moves
 * the confidence (agreeing structured fields raise it, conflicting evidence lowers it).
 */

/** Only this much of the description is read (NFR-1). */
export const MAX_DESCRIPTION_CHARS = 3000;
/** Upper bound on `reasons.length`. */
export const MAX_REASONS = 5;
/**
 * Titles longer than this are junk (keyword stuffing, scraped page text); read only the start.
 * The same cap applies to every string that goes through the title rules (`employmentType`,
 * `jobLevel`): that analysis is super-linear in the input length, so an uncapped scraped value
 * could hold the event loop for seconds inside one synchronous call (Spec 1730 review).
 */
export const MAX_TITLE_CHARS = 300;
/** `experienceRange` is a short phrase ("3-5 Yrs", "Fresher"); read only the start of a longer one. */
export const MAX_FIELD_CHARS = 120;
/** Longest source text quoted verbatim in a reason; longer text is cut and marked with "…". */
const MAX_QUOTE_CHARS = 60;

type Level = Exclude<CareerLevel, 'unknown'>;
type Source = 'title' | 'jobType' | 'employmentType' | 'jobLevel' | 'experienceRange' | 'description';

interface Signal {
  level: Level;
  confidence: CareerLevelConfidence;
  reason: string;
  source: Source;
  /** A years-of-experience lower bound: compared with {@link yearsRelation}, not by distance. */
  years?: number;
  /**
   * A season+year title cue: dropped whenever the title carries any other signal (an intern /
   * new-grad cue or an explicit ladder word at any level) — see {@link resolve}.
   */
  weak?: boolean;
  /** The matched text of a weak cue, for the "ignored …" note when it is dropped. */
  cue?: string;
}

interface Analysis {
  signals: Signal[];
  /** Guard notes ("ignored X because Y"), surfaced as reasons when they changed the outcome. */
  notes: string[];
}

// ─── Level ordering ──────────────────────────────────────────────────────────

/** Title precedence: the first level in this list that has a signal wins. */
const PRECEDENCE: readonly Level[] = [
  'internship',
  'new_grad',
  'executive',
  'director',
  'manager',
  'principal',
  'staff',
  'senior',
  'mid',
  'entry',
];

/** Seniority rung used to decide whether two signals conflict (|Δ| ≥ 2) or merely differ. */
const RANK: Readonly<Record<Level, number>> = {
  internship: 0,
  new_grad: 1,
  entry: 2,
  mid: 3,
  senior: 4,
  manager: 4,
  staff: 5,
  principal: 6,
  director: 6,
  executive: 7,
};

const CONFIDENCE_ORDER: readonly CareerLevelConfidence[] = ['low', 'medium', 'high'];

function up(c: CareerLevelConfidence): CareerLevelConfidence {
  return CONFIDENCE_ORDER[Math.min(2, CONFIDENCE_ORDER.indexOf(c) + 1)]!;
}
function down(c: CareerLevelConfidence): CareerLevelConfidence {
  return CONFIDENCE_ORDER[Math.max(0, CONFIDENCE_ORDER.indexOf(c) - 1)]!;
}
function stronger(a: CareerLevelConfidence, b: CareerLevelConfidence): boolean {
  return CONFIDENCE_ORDER.indexOf(a) > CONFIDENCE_ORDER.indexOf(b);
}
function cap(c: CareerLevelConfidence, max: CareerLevelConfidence): CareerLevelConfidence {
  return stronger(c, max) ? max : c;
}

// ─── Vocabulary ──────────────────────────────────────────────────────────────

const set = (words: string): ReadonlySet<string> => new Set(words.trim().split(/\s+/));

/** Nouns that name a job; a level numeral only counts directly after one of these. */
const ROLE_NOUNS = set(`
  engineer engineers developer developers programmer analyst analysts scientist scientists
  specialist technician tech technologist associate representative rep consultant designer
  administrator admin coordinator accountant auditor architect nurse rn lpn therapist pharmacist
  officer planner buyer recruiter advisor adviser agent clerk assistant investigator researcher
  attorney paralegal mechanic operator inspector writer editor producer tester sde swe sdet sre
  manager supervisor underwriter actuary economist statistician chemist biologist physicist
  geologist surveyor estimator machinist electrician welder drafter trader strategist counselor
  instructor teacher librarian dispatcher driver worker generalist expert professional paramedic
  hygienist radiographer sonographer dietitian caseworker advocate liaison scheduler controller
  bookkeeper teller banker broker adjuster appraiser examiner steward modeler modeller lead
`);

/** A level-numeral after `level` that names a support tier, not seniority. */
const SUPPORT_TIER_NEXT = set('support helpdesk help service desk');

/** Nouns that mark a title as *administering* a programme rather than being enrolled in it. */
const ADMIN_NOUNS = set(`
  recruiter recruiters recruiting recruitment relations coordinator coordinators coordination
  manager managers management director directors specialist specialists partner partners advisor
  advisors adviser advisers counselor counselors counsellor counsellors liaison administrator
  administrators administration officer officers outreach engagement hiring admissions admission
  affairs lead leads head sourcer sourcing mentor mentors supervisor supervisors trainer trainers
  educator educators preceptor preceptors
`);

/**
 * People nouns (admin roles + leadership) that, with a plural, `of/for` or programme-noun
 * early-career cue anywhere in the title, mean "this role runs the programme".
 */
const ADMIN_ROLE_NOUNS = set(`
  recruiter recruiters coordinator coordinators manager managers director directors specialist
  specialists partner partners advisor advisors adviser advisers counselor counselors counsellor
  counsellors liaison administrator administrators officer officers lead head sourcer mentor
  mentors supervisor supervisors trainer trainers dean vp president chief svp evp
`);

/**
 * A recruiting / programme-staff head noun in another segment marks the early-career cue as the
 * audience ("Campus Recruiter - New Grad", "Nurse Educator - New Graduate Residency").
 */
const RECRUITER_HEAD = set(`
  recruiter recruiters sourcer sourcers admissions admission registrar dean educator educators
  preceptor preceptors
`);

/** Programme nouns: `Intern Programs` + a leadership/admin noun anywhere = programme admin. */
const PROGRAM_NOUNS = set('program programs programme programmes');

/** `<X> manager` where X makes the title an individual-contributor role, not people management. */
const IC_MANAGER_PREFIX = set(`
  product program programme project account accounts case care community relationship portfolio
  partner territory category campaign content engagement success release media
`);
const IC_MANAGER_PREFIX2 = new Set([
  'product marketing',
  'partner marketing',
  'social media',
  'customer success',
  'client success',
  'key account',
  'technical program',
  'technical product',
]);
/** `<X> manager` that is unmistakably people management (confidence high). */
const MANAGER_STRONG = set(`
  engineering software people team general senior sr store branch restaurant operations
  department development data security it infrastructure platform plant nurse nursing warehouse
  accounting finance hr
`);

/** `staff <X>` is the staff IC rung only when X is a technical role word. */
const STAFF_TECH = set(`
  software engineer engineers engineering data machine ml ai research researcher scientist
  applied product designer design ux frontend front-end backend back-end full-stack fullstack
  full security site sre infrastructure platform systems system developer architect technical
  network cloud devops mobile ios android web hardware firmware embedded silicon asic fpga
  verification quantitative quant analytics database solutions test qa reliability algorithm
  algorithms computer vision nlp compiler kernel graphics gameplay game program
`);

/** `associate <X>` is the entry rung when X is a working role (not director/principal/partner…). */
const ASSOCIATE_NEXT = set(`
  engineer engineering software developer data scientist science analyst analytics consultant
  product designer design programmer technical solutions ux ui research machine ml ai quality qa
  test systems network security cloud devops site frontend front-end backend back-end full-stack
  fullstack applied quantitative quant business financial finance marketing account project
  program content creative copywriter editor producer accountant auditor actuary actuarial
  underwriter recruiter buyer planner specialist architect
`);

/** Words after `senior` that make it an audience/industry, not a level. */
const SENIOR_GUARD_NEXT = set(`
  living care center centre services service home homes housing community communities citizen
  citizens high secondary school day nutrition meals resident residents companion companions
  helper helpers apartments apartment
`);
const JUNIOR_GUARD_NEXT = set('high college school league');
const LEAD_GUARD_NEXT = set('generation gen abatement paint poisoning based safe free qualification capture nurturing');
const INTERMEDIATE_GUARD_NEXT = set('school care unit');
/** `co-op <X>` retail/co-operative businesses (and the retail jobs they hire for), not a work term. */
const COOP_RETAIL_NEXT = set(`
  food store stores funeral funeralcare pharmacy insurance bank travel legal electrical energy academy
  academies group retail grocery supermarket member members cashier cashiers clerk clerks deli bakery
  produce stocker stockers meat seafood
`);
/** `<X> co-op` where X names a co-operative business (grocery, credit, housing …), not a work term. */
const COOP_BUSINESS_PREV = set(`
  food foods grocery groceries credit housing farm farmers consumer consumers dairy agricultural
  natural organic retail
`);
/**
 * Titles where a season + year is a seasonal job or an academic / coaching term, not a student
 * work term ("Lifeguard - Summer 2026", "Adjunct Faculty - Spring 2026", "Winter 2026 Ski Instructor").
 */
const SEASONAL_GUARD = set(`
  camp seasonal lifeguard lifeguards pool counselor counsellor adjunct faculty lecturer lecturers
  instructor instructors professor professors teacher teachers coach coaches tutor tutors ski snowboard
`);
/**
 * Hires whose season + year is a start date, not a work term: Big Four and law-firm new-grad
 * classes ("Audit Associate - Fall 2026", "Assurance Staff - Fall 2026", "Audit Assistant") and
 * bank analyst classes. Without an intern / student cue the weak season cue is ignored (Q-105).
 */
const SEASON_START_ROLE = set('associate associates staff assistant assistants analyst analysts');
/** Tokens after a season + year that make it a start date / intake, not a term. */
const SEASON_START_NEXT = set('start starts starting intake');
/** `graduate <X>` contexts that are institutional, not a role. */
const GRADUATE_INSTITUTIONAL_NEXT = set('school studies admissions admission medical education affairs office outcomes level');
/** `graduate <X>` contexts that are a graduate-student appointment (→ internship). */
const GRADUATE_STUDENT_NEXT = set('research teaching student students assistant assistants assistantship assistantships');
/** IC role nouns that turn a bank-style `VP` corporate title into a senior IC role. */
const BANK_IC = set(`
  engineer developer analyst scientist architect programmer quant designer strategist researcher
  modeler modeller
`);
const SCHOOL_WORDS = set('school schools elementary middle academy k-12 k-8 charter preschool');
const CXO_GUARD_PREV = set('to for of');

// ─── Text helpers ────────────────────────────────────────────────────────────

/** Any non-ASCII character: only then is Unicode normalisation needed. */
const NON_ASCII_RE = /[^\x00-\x7f]/;
/** Combining marks left behind by NFKD (accents). */
const COMBINING_MARK_RE = /\p{M}/gu;
/** Unicode dash punctuation and the minus sign. */
const DASH_RE = /[\p{Pd}\u2212]/gu;
/** Typographic apostrophes / quotes / acute and grave accents used as apostrophes. */
const APOSTROPHE_RE = /[\u2018\u2019\u02bc\u00b4`]/g;

/**
 * Lower-case, strip diacritics (NFKD), unify dashes/quotes and collapse whitespace. Latin-script
 * only: CJK cues are matched on the NFC form of the raw title (NFKD would split Hangul). Pure-ASCII
 * input (the common case) skips the Unicode passes.
 */
export function normalizeCareerText(s: string): string {
  let out = s;
  if (NON_ASCII_RE.test(out)) {
    out = out.normalize('NFKD').replace(COMBINING_MARK_RE, '').replace(DASH_RE, '-').replace(APOSTROPHE_RE, "'");
  } else if (out.includes('`')) {
    out = out.replace(APOSTROPHE_RE, "'");
  }
  // Only runs of whitespace and non-space whitespace need rewriting; `/\s+/g` would also "replace"
  // every single space, which dominated the cost on 3 KB descriptions.
  return out.toLowerCase().replace(WHITESPACE_RUN_RE, ' ').trim();
}

const WHITESPACE_RUN_RE = /[^\S ]+|\s{2,}/g;

const TOKEN_RE = /[a-z0-9+#]+(?:[-'.][a-z0-9+#]+)*/g;

function tokenize(s: string): string[] {
  return s.match(TOKEN_RE) ?? [];
}

/** Split a normalised title at `, ; : | ( ) [ ] { } / \` and spaced dashes. */
function splitSegments(norm: string): string[] {
  return norm
    .replace(/[,;:|()[\]{}/\\]/g, ' \u0000 ')
    .replace(/\s-+\s/g, ' \u0000 ')
    .split('\u0000')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function quote(s: string): string {
  const t = s.trim();
  return `"${t.length > MAX_QUOTE_CHARS ? `${capAtWord(t, MAX_QUOTE_CHARS)}…` : t}"`;
}

/**
 * Cut `s` to at most `max` characters at a word boundary, so the cut cannot mint a token that was
 * not there ("… manager ii" → "… manager i"). A string with no whitespace in reach is cut hard.
 * Linear: the regex only ever sees `max + 1` characters.
 */
export function capAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max + 1);
  const cut = head.replace(/\s+\S*$/, '');
  return cut.length < head.length ? cut : s.slice(0, max);
}

// ─── Early-career cues (internship / new grad) ──────────────────────────────

interface EarlyCue {
  re: RegExp;
  /** Literal substrings, one of which every match contains — checked on the title first. */
  needles: readonly string[];
  level: 'internship' | 'new_grad';
  confidence: CareerLevelConfidence;
  weak?: boolean;
  /** Plural cue ("internships", "early careers") — programme-admin rule (c) applies. */
  plural?: (match: string) => boolean;
  /**
   * Cue-specific guard over the tokens after / before the match in its segment: return a note to
   * ignore the match, `undefined` to keep it.
   */
  guard?: (after: string[], ctx: TitleContext, before: string[]) => string | undefined;
}

const endsWithS = (m: string): boolean => /s$/.test(m.trim());
const SEASONS = ['summer', 'fall', 'autumn', 'winter', 'spring'] as const;

const EARLY_CUES: readonly EarlyCue[] = [
  // ── internship ──
  {
    // Word-bounded: never matches internal / international / internet / interne / internist.
    re: /\bintern(?:s|ships?)?\b/g,
    needles: ['intern'],
    level: 'internship',
    confidence: 'high',
    plural: (m) => m === 'interns' || m === 'internships',
  },
  { re: /\bextern(?:s|ships?)?\b/g, needles: ['extern'], level: 'internship', confidence: 'medium', plural: endsWithS },
  {
    // `cooperative` never matches (no boundary after "coop").
    re: /\bco-?ops?\b/g,
    needles: ['co-op', 'coop'],
    level: 'internship',
    confidence: 'high',
    plural: endsWithS,
    // "Co-op Food", "Co-op Cashier", "Food Co-op Cashier", "Credit Co-op Teller".
    guard: (after, _ctx, before) => {
      const prev = before[before.length - 1];
      return (after[0] && COOP_RETAIL_NEXT.has(after[0])) || (prev && COOP_BUSINESS_PREV.has(prev))
        ? 'co-operative business, not a work term'
        : undefined;
    },
  },
  {
    re: /\bsummer (?:analyst|associate|intern|student|clerk|law clerk|scholar|researcher|research assistant|fellow)s?\b/g,
    needles: ['summer'],
    level: 'internship',
    confidence: 'high',
  },
  {
    // Season + year ("Summer 2026", "Fall '26", "2027 Spring"): a student term, but only when
    // nothing else in the title explains it. It is the weakest cue: any other title signal
    // outranks it (see resolve()), and the guards below drop it where the season is a start
    // date, a seasonal job, an academic term or the term of a programme someone runs.
    re: /\b(?:summer|fall|autumn|winter|spring)(?: (?:term|semester|session|cohort))? ?(?:20\d{2}|'\d{2})\b|\b20\d{2} (?:summer|fall|autumn|winter|spring)\b/g,
    needles: SEASONS,
    level: 'internship',
    confidence: 'medium',
    weak: true,
    guard: (after, ctx) => {
      if (after[0] && SEASON_START_NEXT.has(after[0])) return 'start date, not a term';
      if (ctx.tokens.some((t) => SEASONAL_GUARD.has(t))) return 'seasonal job or academic term, not a student term';
      if (ctx.tokens.some((t) => SEASON_START_ROLE.has(t))) {
        return 'start date of an associate / staff / assistant / analyst hire, not a student term';
      }
      if (ctx.hasAdminOrLeadership) return 'admin or leadership role, not a student term';
      return undefined;
    },
  },
  {
    re: /\bworking students?\b|\bwerkstudent(?:in|en|innen)?\b|\bwerkstudierender?\b/g,
    needles: ['working student', 'werkstud'],
    level: 'internship',
    confidence: 'high',
  },
  {
    re: /\bstudent (?:worker|assistant|employee|researcher|trainee|intern|technician|developer|engineer|analyst|associate|programmer|nurse|placement|job|research assistant)s?\b/g,
    needles: ['student '],
    level: 'internship',
    confidence: 'high',
  },
  {
    re: /\b(?:summer|winter|spring|fall|autumn|co-?op|placement|thesis|phd|masters?|undergraduate|university|college) students?\b/g,
    needles: [' student'],
    level: 'internship',
    confidence: 'medium',
    plural: endsWithS,
  },
  { re: /\bpraktikant\w*\b|\b\w*praktikum\b/g, needles: ['praktik'], level: 'internship', confidence: 'high' },
  {
    re: /\bstagiaires?\b|\bstagiairs?\b|\bstagista\b|\bstage de fin d'etudes\b/g,
    needles: ['stagia', 'stagis', 'stage de'],
    level: 'internship',
    confidence: 'high',
  },
  {
    re: /\bbecari[oa]s?\b|\bpasantes?\b|\bpasantias?\b|\bpracticas\b|\bpracticantes?\b|\bestagiari[oa]s?\b|\bestagios?\b|\btirocinant[ei]\b|\btirocinio\b/g,
    needles: ['becari', 'pasant', 'practica', 'estagi', 'tirocin'],
    level: 'internship',
    confidence: 'high',
  },
  {
    re: /\bthesis\b|\b(?:master|bachelor|abschluss)arbeit\b/g,
    needles: ['thesis', 'arbeit'],
    level: 'internship',
    confidence: 'medium',
  },
  {
    re: /\b(?:industrial|summer|sandwich|year-long|12-month|12 month|student|work|year) placements?\b|\bplacement (?:student|year)\b|\byear in industry\b/g,
    needles: ['placement', 'year in industry'],
    level: 'internship',
    confidence: 'high',
  },
  {
    re: /\bspring (?:week|insight)\b|\binsight (?:week|programme|program)\b/g,
    needles: ['spring', 'insight'],
    level: 'internship',
    confidence: 'medium',
  },
  {
    // French "stage" (internship) only where it cannot be the English noun: at the start of a
    // segment and followed by a French preposition, or as a whole segment ("... (Stage)").
    // Never "Stage Manager", "Stage Hand", "Stage 2 Clinical Trial".
    re: /^stage(?= (?:de|en|d'|du|au|a|chez)\b)|^stage$/g,
    needles: ['stage'],
    level: 'internship',
    confidence: 'medium',
  },
  {
    re: /\bresearch experiences? for undergraduates\b|\breu\b/g,
    needles: ['for undergraduates', 'reu'],
    level: 'internship',
    confidence: 'medium',
  },
  {
    re: /\bundergraduate (?:research(?:er)?|students?|summer|intern|co-?op|placement|assistant)\b/g,
    needles: ['undergraduate '],
    level: 'internship',
    confidence: 'medium',
  },
  // ── new grad ──
  {
    re: /\bnew[- ]?grad(?:uate)?s?\b|\bnew (?:college|university) grad(?:uate)?s?\b/g,
    needles: ['new'],
    level: 'new_grad',
    confidence: 'high',
    plural: endsWithS,
  },
  { re: /\bncgs?\b/g, needles: ['ncg'], level: 'new_grad', confidence: 'high' },
  {
    re: /\brecent (?:college |university )?grad(?:uate)?s?\b/g,
    needles: ['recent'],
    level: 'new_grad',
    confidence: 'high',
    plural: endsWithS,
  },
  {
    re: /\b(?:university|college|campus) (?:grad(?:uate)?s?|hires?|hiring)\b/g,
    needles: ['university ', 'college ', 'campus '],
    level: 'new_grad',
    confidence: 'high',
    plural: endsWithS,
  },
  {
    re: /\bearly[- ]careers?\b|\bearly[- ]in[- ](?:your |their )?career\b/g,
    needles: ['early'],
    level: 'new_grad',
    confidence: 'high',
    plural: (m) => /careers$/.test(m),
  },
  { re: /\bearly[- ]talent\b/g, needles: ['early'], level: 'new_grad', confidence: 'high' },
  { re: /\bclass of (?:20)?\d{2}\b/g, needles: ['class of'], level: 'new_grad', confidence: 'high' },
  { re: /\bfreshers?\b/g, needles: ['fresher'], level: 'new_grad', confidence: 'high', plural: endsWithS },
  {
    re: /\b(?:nurse|rn|nursing) residen(?:t|ts|cy)\b|\bresidency program(?:me)?\b/g,
    needles: ['residen'],
    level: 'new_grad',
    confidence: 'medium',
  },
  {
    re: /\brotation(?:al)? (?:program(?:me)?|analyst|associate|engineer|development)\b/g,
    needles: ['rotation'],
    level: 'new_grad',
    confidence: 'medium',
  },
];

/** CJK cues, matched on the NFC raw title (no word boundaries in these scripts). */
const CJK_CUES: ReadonlyArray<{ re: RegExp; level: Level; label: string }> = [
  { re: /实习|インターン|인턴/, level: 'internship', label: 'internship (CJK)' },
  { re: /应届|校招|新卒/, level: 'new_grad', label: 'new grad (CJK)' },
];

interface TitleContext {
  tokens: string[];
  /** Any admin or leadership noun anywhere in the title. */
  hasAdminOrLeadership: boolean;
  /** Indices of segments that contain a recruiting head noun. */
  recruiterSegments: ReadonlySet<number>;
}

/**
 * The spec's *program-admin context* (§7.5): returns why an early-career cue describes the
 * programme the role administers rather than the role itself, or `undefined` if it is the role.
 */
function programContext(
  ctx: TitleContext,
  segIndex: number,
  before: string[],
  after: string[],
  plural: boolean,
): string | undefined {
  // (a) an admin noun follows within three tokens ("Intern Program Manager").
  const window = after.slice(0, 3);
  for (let i = 0; i < window.length; i++) {
    const t = window[i]!;
    if (!ADMIN_NOUNS.has(t)) continue;
    if (t === 'manager' || t === 'managers') {
      const prev = window[i - 1];
      // "Graduate Product Manager" is a role; "Intern Program Manager" runs the programme.
      if (prev && IC_MANAGER_PREFIX.has(prev) && !PROGRAM_NOUNS.has(prev)) continue;
    }
    return 'program/recruiting context';
  }
  // (e) "Director, Intern Programs": a programme noun after the cue + a leadership noun.
  if (window.some((t) => PROGRAM_NOUNS.has(t)) && ctx.hasAdminOrLeadership) {
    return 'program/recruiting context';
  }
  // (b) "Head of Early Careers".
  const prevWord = before[before.length - 1];
  if ((prevWord === 'of' || prevWord === 'for') && ctx.hasAdminOrLeadership) {
    return 'program/recruiting context';
  }
  // (c) "Director, Internships".
  if (plural && ctx.hasAdminOrLeadership) return 'program/recruiting context';
  // (d) "Campus Recruiter - New Grad".
  if (ctx.recruiterSegments.size > 0 && !ctx.recruiterSegments.has(segIndex)) {
    return 'program/recruiting context';
  }
  return undefined;
}

// ─── Title analysis ──────────────────────────────────────────────────────────

const LEVEL_WORD = '(junior|jr|jnr|mid-level|mid|intermediate|senior|sr|snr|staff|principal|lead)';
const RANGE_RE = new RegExp(
  `\\b${LEVEL_WORD}\\.?\\s*(?:/|-|&|\\bor\\b|\\bto\\b|\\band\\b)\\s*${LEVEL_WORD}\\b`,
  'g',
);
const RANGE_WORD_LEVEL: Readonly<Record<string, Level>> = {
  junior: 'entry',
  jr: 'entry',
  jnr: 'entry',
  mid: 'mid',
  'mid-level': 'mid',
  intermediate: 'mid',
  senior: 'senior',
  sr: 'senior',
  snr: 'senior',
  lead: 'senior',
  staff: 'staff',
  principal: 'principal',
};

const ROMAN: Readonly<Record<string, number>> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };

function numeralValue(tok: string | undefined): number | undefined {
  if (!tok) return undefined;
  if (tok in ROMAN) return ROMAN[tok];
  return /^[1-5]$/.test(tok) ? Number(tok) : undefined;
}

function numeralSignal(value: number, label: string, isRange: boolean): Signal {
  const level: Level = value === 1 ? 'entry' : value === 2 ? 'mid' : 'senior';
  const confidence: CareerLevelConfidence = isRange ? 'low' : value === 3 ? 'low' : 'medium';
  const reason = isRange ? `title level range ${quote(label)} -> lower bound` : `title level numeral ${quote(label)}`;
  return { level, confidence, reason, source: 'title' };
}

/** Level numerals (`Engineer II`, `Level 1`, `SDE 2`, `Analyst I/II`) — segment-aware. */
function numeralSignals(segments: string[]): Signal[] {
  const out: Signal[] = [];
  const segTokens = segments.map(tokenize);
  segTokens.forEach((toks, s) => {
    // A segment that is only a numeral ("Engineer - II", "Engineer (II)"). Bare `i` / `v` are
    // excluded: "(v/m)" and "(m/w/d)" style gender markers split into one-letter segments.
    if (toks.length === 1 && numeralValue(toks[0]) !== undefined && s > 0) {
      if (toks[0] === 'i' || toks[0] === 'v') return;
      const prevToks = segTokens[s - 1]!;
      const prevTok = prevToks[prevToks.length - 1];
      // "I/II" was already handled as a range from the previous segment.
      const prevIsNumeral = numeralValue(prevTok) !== undefined;
      if (!prevIsNumeral && prevTok && ROLE_NOUNS.has(prevTok)) {
        out.push(numeralSignal(numeralValue(toks[0])!, `${prevTok} ${toks[0]}`, false));
      }
      return;
    }
    for (let i = 1; i < toks.length; i++) {
      const v = numeralValue(toks[i]);
      if (v === undefined) continue;
      const prev = toks[i - 1]!;
      const isLevelWord = prev === 'level' || prev === 'lvl';
      if (!isLevelWord && !ROLE_NOUNS.has(prev)) continue;
      if (isLevelWord && toks[i + 1] && SUPPORT_TIER_NEXT.has(toks[i + 1]!)) continue;
      // Ranges inside the segment ("II or III", "1-2" is one token and not a numeral).
      const conj = toks[i + 1];
      const v2 = numeralValue(toks[i + 2]);
      if (conj && (conj === 'or' || conj === 'to' || conj === 'and' || conj === '&') && v2 !== undefined) {
        out.push(numeralSignal(Math.min(v, v2), `${toks[i]} ${conj} ${toks[i + 2]}`, true));
        break;
      }
      // Range across a slash ("Engineer I/II" → segments "engineer i", "ii").
      const nextSeg = segTokens[s + 1];
      if (i === toks.length - 1 && nextSeg && nextSeg.length === 1 && numeralValue(nextSeg[0]) !== undefined) {
        out.push(numeralSignal(Math.min(v, numeralValue(nextSeg[0])!), `${toks[i]}/${nextSeg[0]}`, true));
        break;
      }
      out.push(numeralSignal(v, `${prev} ${toks[i]}`, false));
      break;
    }
  });
  return out;
}

/** True when `index` in `norm` falls inside one of the given `[start, end)` spans. */
function inSpans(index: number, spans: ReadonlyArray<[number, number]>): boolean {
  return spans.some(([a, b]) => index >= a && index < b);
}

/** Tokens immediately before / after a match within `text`. */
function around(text: string, start: number, end: number): { before: string[]; after: string[] } {
  return { before: tokenize(text.slice(0, start)), after: tokenize(text.slice(end)) };
}

/**
 * Iterate the matches of a *global* regex without `String.prototype.matchAll`, which clones the
 * RegExp on every call — at ~60 rules × 30,000 jobs that clone dominated the cost (NFR-2).
 * Synchronous and non-reentrant per regex, so sharing the module-level instances is safe.
 */
function execAll(re: RegExp, s: string, fn: (m: RegExpExecArray) => void): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0].length === 0) re.lastIndex += 1;
    fn(m);
  }
  re.lastIndex = 0;
}

const GRADUATE_RE = /\bgraduates?\b/g;
const TRAINEE_RE = /\btrainees?\b|\bapprentice(?:ship)?s?\b/g;

/** Cheap gate: a title with none of these substrings cannot carry an early-career cue. */
const EARLY_PREFILTER =
  /intern|extern|co-?op|summer|fall|autumn|winter|spring|student|praktik|stagi|stage|becari|pasant|practica|estagi|tirocin|thesis|arbeit|placement|industry|grad|ncg|recent|universit|college|campus|early|class of|fresher|residen|rotation|reu|werkstud/;
/** Cheap gate: a title with none of these substrings cannot carry a ladder/management keyword. */
const LADDER_PREFILTER =
  /vice|vp|president|chief|ceo|cfo|cto|coo|cio|cmo|ciso|chro|direct|c-suite|c-level|partner|founder|head|manag|mgr|supervis|forem|lead|chef|principal|distinguished|fellow|staff|senior|sr|snr|mid|intermediate|journey|junior|jr|jnr|entry|associate|trainee|apprentic|post/;

// Ladder / management rules (spec §7.5 rows 3–10), hoisted so they compile once.
const VP_RE = /\b(?:(?:senior|sr|executive|group|regional|assistant|associate) )?(?:vice[- ]president|vp|svp|evp|avp)\b/g;
const PRESIDENT_RE = /(?<!vice[- ])\bpresident\b/g;
const CHIEF_OF_STAFF_RE = /\bchief of staff\b/g;
const CHIEF_RE = /\bchief\b(?! of staff)/g;
const CXO_RE = /\b(?:ceo|cfo|cto|coo|cio|cmo|ciso|chro)\b/g;
const EXEC_DIRECTOR_RE = /\b(?:executive|managing) director\b|\bc-(?:suite|level)\b/g;
const EXEC_PARTNER_RE = /\b(?:managing|general|founding|senior|equity|salaried|name|named) partners?\b/g;
/** Words that may follow a head-noun "partner(s)" in the same segment ("Senior Partner at X"). */
const PARTNER_HEAD_NEXT = set('at of in and or');
const FOUNDER_RE = /\b(?:co-?)?founders?\b/g;
const DIRECTOR_RE = /\bdirectors?\b/g;
const HEAD_OF_RE = /\bhead of\b/g;
const GROUP_PM_RE = /\bgroup (?:product|program|project) managers?\b/g;
const MANAGER_RE = /\bmanagers?\b|\bmgr\b/g;
const SUPERVISOR_RE = /\bsupervisors?\b|\bforem[ae]n\b|\bforeperson\b/g;
const TEAM_LEAD_RE = /\b(?:team|shift|crew|unit|section|squad|group) lead(?:er)?s?\b/g;
const HEAD_CHEF_RE = /\bhead (?:chef|coach|cook|baker|brewer|gardener|housekeeper)\b|\bexecutive chef\b/g;
const PRINCIPAL_RE = /\bprincipal\b/g;
const SEGMENT_BREAK_RE = /[,;:|()[\]{}/\\]|\s-+\s/;
const DISTINGUISHED_RE = /\bdistinguished (?:engineer|scientist|architect|fellow|member|technologist|researcher|software)\b/g;
const FELLOW_RE = /\btechnical fellow\b|\b(?:ibm|intel|amd|nvidia|microsoft|google|apple|oracle) fellow\b/g;
const STAFF_RE = /\bstaff ([a-z0-9+#-]+)/g;
const SENIOR_RE = /\b(?:senior|sr|snr)\b\.?(?:[\s-]+([a-z]+))?/g;
const LEAD_RE = /\blead\b(?:[\s-]+([a-z]+))?/g;
const MID_LEVEL_RE = /\bmid[- ]?level\b|\bmidlevel\b/g;
const MID_ROLE_RE = /\bmid (?:[a-z+#.-]+ )?(?:developer|engineer|designer|analyst|programmer|scientist|accountant|consultant)s?\b/g;
const INTERMEDIATE_RE = /\bintermediate\b(?: ([a-z]+))?/g;
const JOURNEY_RE = /\bjourney(?:man|men|person|woman|worker)\b|\bjourney[- ]level\b/g;
const JUNIOR_RE = /\b(?:junior|jr|jnr)\b\.?(?: ([a-z]+))?/g;
const ENTRY_LEVEL_RE = /\bentry[- ]?level\b/g;
const ASSOCIATE_RE = /\bassociate ([a-z0-9+#-]+)/g;
const POSTDOC_RE = /\bpost-?doc(?:toral)?s?\b|\bpost doc(?:toral)?\b/g;

/**
 * Collect every level signal the title carries. `origin` labels the reasons (the same rules are
 * reused for `employmentType` / `jobLevel` strings).
 *
 * The input is capped at {@link MAX_TITLE_CHARS} here rather than by the callers, so no caller
 * can feed this super-linear analysis (`around()` re-tokenises the prefix of every match) an
 * unbounded string.
 */
function analyzeTitle(raw: string, origin: Source): Analysis {
  const signals: Signal[] = [];
  const notes: string[] = [];
  const norm = normalizeCareerText(capAtWord(raw, MAX_TITLE_CHARS));
  if (!norm) return { signals, notes };
  const label = origin === 'title' ? 'title' : origin;
  const add = (level: Level, confidence: CareerLevelConfidence, what: string, extra?: Partial<Signal>): void => {
    signals.push({ level, confidence, reason: `${label}: ${what}`, source: origin, ...extra });
  };

  const segments = splitSegments(norm);
  const tokens = tokenize(norm);
  const ctx: TitleContext = {
    tokens,
    hasAdminOrLeadership: tokens.some((t) => ADMIN_ROLE_NOUNS.has(t)),
    recruiterSegments: new Set(
      segments.map((s, i) => (tokenize(s).some((t) => RECRUITER_HEAD.has(t)) ? i : -1)).filter((i) => i >= 0),
    ),
  };

  // 1 + 2 — internship / new-grad cues, each checked against the programme-admin guard.
  if (EARLY_PREFILTER.test(norm)) {
    const liveCues = EARLY_CUES.filter((cue) => cue.needles.some((n) => norm.includes(n)));
    segments.forEach((seg, segIndex) => {
      for (const cue of liveCues) {
        execAll(cue.re, seg, (m) => {
          const start = m.index;
          const { before, after } = around(seg, start, start + m[0].length);
          const specific = cue.guard?.(after, ctx, before);
          if (specific) {
            notes.push(`ignored ${quote(m[0])} (${specific})`);
            return;
          }
          const why = programContext(ctx, segIndex, before, after, cue.plural?.(m[0]) ?? false);
          if (why) {
            notes.push(`ignored ${quote(m[0])} (${why})`);
            return;
          }
          add(cue.level, cue.confidence, quote(m[0]), cue.weak ? { weak: true, cue: m[0] } : undefined);
        });
      }
      graduateSignals(seg, segIndex, ctx, add, notes);
    });
  }
  if (NON_ASCII_RE.test(raw)) {
    const nfc = raw.normalize('NFC');
    for (const cue of CJK_CUES) {
      if (cue.re.test(nfc)) add(cue.level, 'high', cue.label);
    }
  }

  const ladder = LADDER_PREFILTER.test(norm);
  // Keyword ranges ("Junior/Mid", "Mid-Senior", "Senior/Staff") -> the lower bound, low confidence.
  const rangeSpans: Array<[number, number]> = [];
  if (ladder) {
    execAll(RANGE_RE, norm, (m) => {
      const a = RANGE_WORD_LEVEL[m[1]!]!;
      const b = RANGE_WORD_LEVEL[m[2]!]!;
      rangeSpans.push([m.index, m.index + m[0].length]);
      if (a === b) {
        add(a, 'medium', quote(m[0]));
      } else {
        const lower = RANK[a] <= RANK[b] ? a : b;
        add(lower, 'low', `range ${quote(m[0])} -> lower bound`);
      }
    });
  }
  /**
   * Run one ladder rule. `needles` are literal substrings, at least one of which every match of
   * `re` contains: checking them on the (short) title first skips the regex for the ~95% of rules
   * that cannot match a given title (NFR-2).
   */
  const each = (
    needles: string | readonly string[],
    re: RegExp,
    fn: (m: RegExpExecArray, start: number) => void,
  ): void => {
    if (!ladder) return;
    if (typeof needles === 'string' ? !norm.includes(needles) : !needles.some((n) => norm.includes(n))) return;
    execAll(re, norm, (m) => {
      if (!inSpans(m.index, rangeSpans)) fn(m, m.index);
    });
  };

  /**
   * Rules 3–5 name a title-holder. When that holder is someone else ("Executive Assistant to the
   * VP", "Assistant to the Regional Director", "Recruiter for Store Managers") the rule is skipped
   * and a note explains why. Returns `true` when the match at `start` is held by someone else.
   */
  const someoneElses = (m: RegExpExecArray, start: number): boolean => {
    if (!heldBySomeoneElse(tokenize(norm.slice(0, start)))) return false;
    notes.push(`ignored ${quote(m[0])} (someone else's title)`);
    return true;
  };

  // 3 — executive (and the bank corporate-title exception).
  each(['vice', 'vp'], VP_RE, (m, start) => {
    if (someoneElses(m, start)) return;
    const { after } = around(norm, start, start + m[0].length);
    const bankStyle = after[0] !== 'of' && tokens.some((t) => BANK_IC.has(t));
    if (bankStyle) add('senior', 'medium', `${quote(m[0])} with an IC role (bank corporate title)`);
    else add('executive', 'high', quote(m[0]));
  });
  each('president', PRESIDENT_RE, (m, start) => {
    if (!someoneElses(m, start)) add('executive', 'high', quote(m[0]));
  });
  each('chief', CHIEF_OF_STAFF_RE, (m, start) => {
    if (!someoneElses(m, start)) add('director', 'medium', quote(m[0]));
  });
  each('chief', CHIEF_RE, (m, start) => {
    if (someoneElses(m, start)) return;
    const { after } = around(norm, start, start + m[0].length);
    const isOfficer = after.slice(0, 5).includes('officer');
    add('executive', isOfficer ? 'high' : 'medium', isOfficer ? '"chief ... officer"' : quote(m[0]));
  });
  each(['ceo', 'cfo', 'cto', 'coo', 'cio', 'cmo', 'ciso', 'chro'], CXO_RE, (m, start) => {
    if (!someoneElses(m, start)) add('executive', 'high', quote(m[0]));
  });
  each(['director', 'c-'], EXEC_DIRECTOR_RE, (m, start) => {
    if (!someoneElses(m, start)) add('executive', 'high', quote(m[0]));
  });
  each('partner', EXEC_PARTNER_RE, (m, start) => {
    if (someoneElses(m, start)) return;
    // A partnership rank only when "partner(s)" is the head noun: end of the segment ("Managing
    // Partner", "Senior Partner, Tax") or a connective ("… at X", "… & Head of Tax"). Before a
    // role noun it names the partner / channel function of an IC ("Senior Partner Manager",
    // "Senior Partner Solutions Architect"), and the rest of the title decides.
    const rest = norm.slice(start + m[0].length).split(SEGMENT_BREAK_RE)[0] ?? '';
    const next = /^\s*&/.test(rest) ? 'and' : tokenize(rest)[0];
    if (next && !PARTNER_HEAD_NEXT.has(next)) {
      notes.push(`ignored ${quote(m[0])} (partner modifies ${quote(next)}, not a partnership rank)`);
      return;
    }
    add('executive', 'high', quote(m[0]));
  });
  if (ladder && norm.includes('partner')) {
    const firstSeg = tokenize(segments[0] ?? '');
    if (firstSeg.length === 1 && (firstSeg[0] === 'partner' || firstSeg[0] === 'partners')) {
      add('executive', 'medium', '"partner"');
    }
  }
  each('founder', FOUNDER_RE, (m, start) => {
    if (someoneElses(m, start)) return;
    // "Founder's Associate", "Founders' Office", "Founders Office Associate", "Founders Fund":
    // a possessive, or a plural modifying a following noun, names a function, not a founder.
    const rest = norm.slice(start + m[0].length);
    const possessive = /^'s\b/.test(rest) || (m[0].endsWith('s') && rest.startsWith("'"));
    const pluralModifier =
      m[0].endsWith('s') && tokenize(rest.split(SEGMENT_BREAK_RE)[0] ?? '').length > 0;
    if (possessive || pluralModifier) {
      notes.push(`ignored ${quote(m[0])} (a founders' office or programme, not a founder)`);
      return;
    }
    add('executive', 'high', quote(m[0]));
  });

  // 4 — director.
  each('director', DIRECTOR_RE, (m, start) => {
    if (someoneElses(m, start)) return;
    const { before } = around(norm, start, start + m[0].length);
    if (before[before.length - 1] === 'funeral') {
      notes.push('ignored "director" (funeral director)');
      return;
    }
    add('director', 'high', quote(m[0]));
  });
  each('head of', HEAD_OF_RE, (m, start) => {
    if (!someoneElses(m, start)) add('director', 'high', quote(m[0]));
  });

  // 5 — manager.
  each('group', GROUP_PM_RE, (m, start) => {
    if (!someoneElses(m, start)) add('manager', 'high', quote(m[0]));
  });
  each(['manager', 'mgr'], MANAGER_RE, (m, start) => {
    const { before } = around(norm, start, start + m[0].length);
    const p1 = before[before.length - 1];
    const p2 = before.length >= 2 ? `${before[before.length - 2]} ${p1}` : undefined;
    if ((p1 && IC_MANAGER_PREFIX.has(p1)) || (p2 && IC_MANAGER_PREFIX2.has(p2))) return; // IC title
    if (someoneElses(m, start)) return;
    add('manager', !p1 || MANAGER_STRONG.has(p1) ? 'high' : 'medium', p1 ? quote(`${p1} ${m[0]}`) : quote(m[0]));
  });
  each(['supervisor', 'forem', 'foreperson'], SUPERVISOR_RE, (m, start) => {
    if (!someoneElses(m, start)) add('manager', 'medium', quote(m[0]));
  });
  each('lead', TEAM_LEAD_RE, (m, start) => {
    if (!someoneElses(m, start)) add('manager', 'medium', quote(m[0]));
  });
  each(['chef', 'head '], HEAD_CHEF_RE, (m, start) => {
    if (!someoneElses(m, start)) add('manager', 'medium', quote(m[0]));
  });

  // 6 — principal / distinguished / fellow.
  each('principal', PRINCIPAL_RE, (m, start) => {
    const { before, after } = around(norm, start, start + m[0].length);
    const prev = before[before.length - 1];
    const school = tokens.some((t) => SCHOOL_WORDS.has(t)) || prev === 'assistant' || prev === 'vice' || prev === 'deputy';
    if (school) add('director', 'medium', `${quote(m[0])} (school leadership)`);
    else if (after[0] === 'investigator') add('principal', 'high', '"principal investigator"');
    else if (prev === 'associate') add('principal', 'medium', '"associate principal"');
    else {
      const sameSegmentNext = tokenize(norm.slice(start + m[0].length).split(SEGMENT_BREAK_RE)[0] ?? '')[0];
      add('principal', sameSegmentNext ? 'high' : 'medium', quote(m[0]));
    }
  });
  each('distinguished', DISTINGUISHED_RE, (m) => add('principal', 'high', quote(m[0])));
  each('fellow', FELLOW_RE, (m) => add('principal', 'high', quote(m[0])));

  // 7 — staff (tech only); staff accountant/auditor is the entry rung.
  each('staff', STAFF_RE, (m) => {
    const next = m[1]!;
    if (STAFF_TECH.has(next)) add('staff', 'high', quote(`staff ${next}`));
    else if (/^(?:accountants?|auditors?)$/.test(next)) add('entry', 'medium', quote(`staff ${next}`));
  });

  // 8 — senior.
  each(['senior', 'sr', 'snr'], SENIOR_RE, (m) => {
    const next = m[1];
    if (next && SENIOR_GUARD_NEXT.has(next)) {
      notes.push(`ignored ${quote(m[0])} (audience, not a level)`);
      return;
    }
    add('senior', 'high', quote(m[0].replace(/[\s-]+[a-z]+$/, '')));
  });
  each('lead', LEAD_RE, (m, start) => {
    const { before } = around(norm, start, start + 4);
    const prev = before[before.length - 1];
    if (prev && /^(?:team|shift|crew|unit|section|squad|group)$/.test(prev)) return; // manager rule
    const next = m[1];
    if (next && LEAD_GUARD_NEXT.has(next)) return;
    add('senior', 'medium', '"lead"');
  });

  // 9 — mid.
  each('mid', MID_LEVEL_RE, (m) => add('mid', 'high', quote(m[0])));
  each('mid', MID_ROLE_RE, (m) => add('mid', 'medium', quote(m[0])));
  each('intermediate', INTERMEDIATE_RE, (m) => {
    if (m[1] && INTERMEDIATE_GUARD_NEXT.has(m[1])) return;
    add('mid', 'high', '"intermediate"');
  });
  each('journey', JOURNEY_RE, (m) => add('mid', 'medium', quote(m[0])));

  // 10 — entry.
  each(['junior', 'jr', 'jnr'], JUNIOR_RE, (m) => {
    if (m[1] && JUNIOR_GUARD_NEXT.has(m[1])) {
      notes.push(`ignored ${quote(m[0])} (school/league, not a level)`);
      return;
    }
    add('entry', 'high', quote(m[0].replace(/ [a-z]+$/, '')));
  });
  each('entry', ENTRY_LEVEL_RE, (m) => add('entry', 'high', quote(m[0])));
  each('associate', ASSOCIATE_RE, (m) => {
    if (ASSOCIATE_NEXT.has(m[1]!)) add('entry', 'medium', quote(`associate ${m[1]}`));
  });
  if (ladder && (norm.includes('trainee') || norm.includes('apprentic'))) {
    segments.forEach((seg, segIndex) => {
      execAll(TRAINEE_RE, seg, (m) => {
        const { before, after } = around(seg, m.index, m.index + m[0].length);
        const why = programContext(ctx, segIndex, before, after, /s$/.test(m[0]));
        if (why) notes.push(`ignored ${quote(m[0])} (${why})`);
        else add('entry', 'medium', quote(m[0]));
      });
    });
  }
  each('post', POSTDOC_RE, (m) => add('entry', 'medium', quote(m[0])));

  // Numerals last: they are the weakest title evidence.
  for (const s of numeralSignals(segments)) {
    signals.push({ ...s, reason: s.reason.replace(/^title/, label), source: origin });
  }

  return { signals, notes };
}

/** Modifier words allowed between `to/for/of [the]` and the title it governs ("to the Regional VP"). */
const HELD_BY_MAX_MODIFIERS = 2;

/**
 * `Chief of Staff to the CEO`, `Assistant to the (Senior Regional) Director`, `Office of the
 * Founders`, `Recruiter for Store Managers`: the title-holder is someone else. `before` is every
 * token before the match. True when, at most {@link HELD_BY_MAX_MODIFIERS} words before it, comes
 * `to` / `for`, or `to` / `for` / `of` + `the` / `our`. A bare `of` counts only right before the
 * match (`Board of Directors`, `Office of CEO`): with a modifier in between it is part of a
 * compound noun (`Front of House Manager`), not a holder.
 */
function heldBySomeoneElse(before: string[]): boolean {
  for (let i = before.length - 1, skipped = 0; i >= 0 && skipped <= HELD_BY_MAX_MODIFIERS; i--, skipped++) {
    const tok = before[i]!;
    if (tok === 'to' || tok === 'for') return true;
    if (tok === 'of') return skipped === 0;
    if (tok === 'the' || tok === 'our') {
      const prev = before[i - 1];
      return prev !== undefined && CXO_GUARD_PREV.has(prev);
    }
  }
  return false;
}

/** `graduate` (not `new graduate` etc., which EARLY_CUES cover): role, programme or appointment. */
function graduateSignals(
  seg: string,
  segIndex: number,
  ctx: TitleContext,
  add: (level: Level, c: CareerLevelConfidence, what: string) => void,
  notes: string[],
): void {
  execAll(GRADUATE_RE, seg, (m) => {
    const start = m.index;
    const { before, after } = around(seg, start, start + m[0].length);
    const prev = before[before.length - 1];
    if (prev && /^(?:new|recent|university|college|campus|post)$/.test(prev)) return; // handled / post-graduate
    const next = after[0];
    if (next && GRADUATE_INSTITUTIONAL_NEXT.has(next)) {
      notes.push(`ignored ${quote(`${m[0]} ${next}`)} (institutional, not a role)`);
      return;
    }
    const why = programContext(ctx, segIndex, before, after, m[0] === 'graduates');
    if (why) {
      notes.push(`ignored ${quote(m[0])} (${why})`);
      return;
    }
    if (next && GRADUATE_STUDENT_NEXT.has(next)) {
      add('internship', 'medium', `${quote(`${m[0]} ${next}`)} (graduate-student appointment)`);
      return;
    }
    add('new_grad', 'high', quote(m[0]));
  });
}

/**
 * Resolve a title's signals to one, by precedence; `undefined` when there are none.
 *
 * A weak cue (season + year) only counts when it is the title's *only* evidence: any other
 * signal — an intern / new-grad cue or an explicit ladder word at any level — drops it, so
 * "Senior Software Engineer (Fall 2026)" is `senior`, not an internship. `dropped` lists the weak
 * cues that were discarded, for the reasons.
 */
function resolve(signals: Signal[]): { signal: Signal; also: Signal[]; dropped: Signal[] } | undefined {
  if (!signals.length) return undefined;
  const hasExplicit = signals.some((s) => !s.weak);
  const usable = hasExplicit ? signals.filter((s) => !s.weak) : signals;
  const dropped = hasExplicit ? signals.filter((s) => s.weak) : [];
  for (const level of PRECEDENCE) {
    const matching = usable.filter((s) => s.level === level);
    if (!matching.length) continue;
    const best = matching.reduce((a, b) => (stronger(b.confidence, a.confidence) ? b : a));
    return { signal: best, also: usable.filter((s) => s !== best), dropped };
  }
  return undefined;
}

// ─── Structured source fields ────────────────────────────────────────────────

const JOB_LEVEL_MAP: ReadonlyArray<[RegExp, Level, CareerLevelConfidence]> = [
  [/^(?:internship|intern)$/, 'internship', 'medium'],
  [/^(?:entry[- ]?level|entry)$/, 'entry', 'medium'],
  [/^associate$/, 'entry', 'low'],
  [/^mid[- ]senior(?: level)?$/, 'mid', 'low'],
  [/^(?:mid[- ]?level|mid)$/, 'mid', 'medium'],
  [/^senior(?: level)?$/, 'senior', 'medium'],
  [/^director$/, 'director', 'medium'],
  [/^executive$/, 'executive', 'medium'],
];

function yearsLevel(min: number): Level {
  return min <= 1 ? 'entry' : min <= 4 ? 'mid' : 'senior';
}

function structuredSignals(input: CareerLevelInput): Signal[] {
  const out: Signal[] = [];
  const types = Array.isArray(input.jobType) ? input.jobType : [];
  if (types.some((t) => typeof t === 'string' && t.toLowerCase() === 'internship')) {
    out.push({ level: 'internship', confidence: 'medium', reason: 'jobType: internship', source: 'jobType' });
  }
  if (typeof input.employmentType === 'string' && input.employmentType.trim()) {
    const r = resolve(analyzeTitle(input.employmentType, 'employmentType').signals);
    if (r) out.push({ ...r.signal, confidence: cap(r.signal.confidence, 'medium') });
  }
  if (typeof input.jobLevel === 'string' && input.jobLevel.trim()) {
    const norm = normalizeCareerText(capAtWord(input.jobLevel, MAX_TITLE_CHARS));
    const mapped = JOB_LEVEL_MAP.find(([re]) => re.test(norm));
    if (mapped) {
      out.push({ level: mapped[1], confidence: mapped[2], reason: `jobLevel: ${quote(input.jobLevel)}`, source: 'jobLevel' });
    } else if (!/^(?:not applicable|n\/a|none|other)$/.test(norm)) {
      const r = resolve(analyzeTitle(input.jobLevel, 'jobLevel').signals);
      if (r) out.push({ ...r.signal, confidence: cap(r.signal.confidence, 'medium') });
    }
  }
  if (typeof input.experienceRange === 'string' && input.experienceRange.trim()) {
    const norm = normalizeCareerText(capAtWord(input.experienceRange, MAX_FIELD_CHARS));
    if (/\bfreshers?\b/.test(norm)) {
      out.push({ level: 'new_grad', confidence: 'medium', reason: `experienceRange: ${quote(input.experienceRange)}`, source: 'experienceRange' });
    } else {
      const m = /(\d{1,2})\s*(?:(?:-|to)\s*\d{1,2}\s*)?\+?\s*(?:yrs?|years?)\b/.exec(norm);
      if (m) {
        const min = Number(m[1]);
        out.push({
          level: yearsLevel(min),
          confidence: 'medium',
          reason: `experienceRange: ${quote(input.experienceRange)} (${min}+ years)`,
          source: 'experienceRange',
          years: min,
        });
      }
    }
  }
  return out;
}

// ─── Description ─────────────────────────────────────────────────────────────

const NUM_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};
const NUM = '(\\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)';

/*
 * Years of experience are found by locating each "year(s)/yr(s)" word and reading a small window
 * around it, instead of running one large regex from every position of a 3,000-character text.
 */
const YEAR_WORD_RE = /\b(?:years?|yrs?)\b/g;
/** Window ending just before the year word: "5+ ", "3-5 ", "at least two ". */
const YEARS_NUMBER_BEFORE_RE = new RegExp(`\\b${NUM}\\s*\\+?\\s*(?:(?:-|to|or)\\s*${NUM}\\s*\\+?\\s*)?$`);
/** Window starting at the year word: "years of (relevant) experience", "years' experience". */
const YEARS_THEN_EXPERIENCE_RE =
  /^(?:years?|yrs?)'?\s+(?:of\s+)?(?:(?!years?\b|yrs?\b|degree\b)[a-z0-9/&,+.-]+\s+){0,5}?experience\b/;
/** Window ending just before the year word: "experience: 3+ ", "experience of 2-4 ". */
const EXPERIENCE_THEN_NUMBER_RE = new RegExp(
  `\\bexperience\\s*(?:of|:|-)?\\s*${NUM}\\s*\\+?\\s*(?:(?:-|to)\\s*${NUM}\\s*)?$`,
);

interface DescriptionCue {
  re: RegExp;
  level: Level;
  label: string;
  /** The regex only runs when the text contains one of these substrings (cheap gate). */
  needles: readonly string[];
}

const DESCRIPTION_CUES: readonly DescriptionCue[] = [
  {
    re: /\bthis (?:is an? |role is an? |position is an? |opportunity is an? )?(?:[a-z0-9-]+ ){0,3}?(?:internship|co-?op)\b/,
    level: 'internship',
    label: '"this ... internship"',
    needles: ['internship', 'co-op', 'coop'],
  },
  {
    re: /\b(?:\d{1,2}|eight|nine|ten|eleven|twelve|fourteen|sixteen)[- ]week (?:[a-z-]+ ){0,2}?(?:internship|co-?op)\b/,
    level: 'internship',
    label: '"N-week internship"',
    needles: ['week'],
  },
  { re: /\bas an? (?:[a-z-]+ ){0,3}?intern\b/, level: 'internship', label: '"as an intern"', needles: ['intern'] },
  {
    re: /\b(?:the|our) (?:[a-z-]+ ){0,2}?intern will\b|\binterns will\b/,
    level: 'internship',
    label: '"the intern will"',
    needles: ['intern will', 'interns will'],
  },
  {
    re: /\bduring (?:your|the|this) (?:[a-z-]+ )?internship\b/,
    level: 'internship',
    label: '"during your internship"',
    needles: ['during'],
  },
  {
    re: /\bmust be (?:currently )?enrolled\b|\breturning to (?:school|university|college|your studies|campus)\b/,
    level: 'internship',
    label: '"currently enrolled"',
    needles: ['enrolled', 'returning to'],
  },
  { re: /\bclass of 20\d{2}\b/, level: 'new_grad', label: '"class of 20xx"', needles: ['class of'] },
  {
    re: /\b(?:open to|for|seeking|looking for|ideal for|designed for|welcom(?:e|es|ing)|calling all|targeted at|aimed at|intended for|reserved for) (?:[a-z-]+ ){0,2}?(?:new|recent) (?:college |university )?grad(?:uate)?s?\b/,
    level: 'new_grad',
    label: '"for recent graduates"',
    needles: ['new grad', 'recent grad', 'new college grad', 'recent college grad', 'new university grad', 'recent university grad'],
  },
  {
    re: /\b(?:new|recent) (?:college |university )?grad(?:uate)?s? (?:are |is )?(?:encouraged|welcome|eligible)\b/,
    level: 'new_grad',
    label: '"recent graduates welcome"',
    needles: ['encouraged', 'welcome', 'eligible'],
  },
  {
    re: /\bnew grad(?:uate)? (?:role|position|opportunit(?:y|ies)|candidates?|cohort)\b/,
    level: 'new_grad',
    label: '"new grad role"',
    needles: ['new grad'],
  },
  {
    re: /\bearly[- ]career (?:candidates?|professionals?|engineers?|role|position)\b/,
    level: 'new_grad',
    label: '"early-career candidates"',
    needles: ['early'],
  },
  {
    re: /\brecently graduated\b|\bgraduated within the (?:last|past)\b/,
    level: 'new_grad',
    label: '"recently graduated"',
    needles: ['graduated'],
  },
  {
    re: /\bentry[- ]level (?:role|position|opportunity|job)\b|\bthis is an? entry[- ]level\b/,
    level: 'entry',
    label: '"entry-level role"',
    needles: ['entry'],
  },
  {
    re: /\bno (?:prior |previous |professional |work )?experience (?:is )?(?:required|necessary|needed)\b/,
    level: 'entry',
    label: '"no experience required"',
    needles: ['no prior', 'no previous', 'no professional', 'no work', 'no experience'],
  },
  {
    re: /\b(?:manage|lead|build and lead|grow and lead|hire and lead|managing|leading) (?:and (?:grow|develop|mentor) )?(?:a |the |our )?(?:[a-z-]+ ){0,2}?team of (?:\d+|two|three|four|five|six|seven|eight|nine|ten)\b|\b\d+\+? direct reports\b|\bpeople manager\b/,
    level: 'manager',
    label: '"manage a team of N"',
    needles: ['team of', 'direct report', 'people manager'],
  },
];

/** Every description needle, longest first. Exported for the invariant test only. */
export const DESCRIPTION_NEEDLES: readonly string[] = [...new Set(DESCRIPTION_CUES.flatMap((c) => c.needles))].sort(
  (a, b) => b.length - a.length,
);
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * One pass finds the needles present instead of ~30 `includes` scans of the same 3 KB text. A
 * plain (consuming) alternation lets V8 use its fast literal scan; it is exact here because no
 * needle occurs *inside* another except as a prefix, which {@link NEEDLE_PREFIXES} restores
 * (asserted by a unit test).
 */
const DESCRIPTION_ANCHOR_RE = new RegExp(DESCRIPTION_NEEDLES.map(escapeRegExp).join('|'), 'g');
/** A needle found at a position implies every shorter needle that is its prefix is there too. */
const NEEDLE_PREFIXES: ReadonlyMap<string, readonly string[]> = new Map(
  DESCRIPTION_NEEDLES.map((n) => [n, DESCRIPTION_NEEDLES.filter((o) => n.startsWith(o))]),
);

function numberOf(tok: string | undefined): number | undefined {
  if (tok === undefined) return undefined;
  if (/^\d+$/.test(tok)) return Number(tok);
  return NUM_WORDS[tok];
}

/** Strip tags/markdown, normalise, and keep the first {@link MAX_DESCRIPTION_CHARS} characters. */
function prepareDescription(desc: string): string {
  // Tags and entities only shrink the text, so 1.5x the budget of raw input is always enough.
  const budget = MAX_DESCRIPTION_CHARS * 1.5;
  let text = desc.length > budget ? desc.slice(0, budget) : desc;
  if (text.includes('<')) text = text.replace(/<[^>]*>/g, ' ');
  if (text.includes('&')) text = text.replace(/&nbsp;|&amp;|&#?\w+;/g, ' ');
  text = text.replace(/[*_#`>|~]+/g, ' ');
  return normalizeCareerText(text).slice(0, MAX_DESCRIPTION_CHARS);
}

/** Lower bounds of every "N years of experience" mention in `text`. */
function experienceYears(text: string): number[] {
  const out: number[] = [];
  execAll(YEAR_WORD_RE, text, (m) => {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    let a: number | undefined;
    let b: number | undefined;
    const numbered = YEARS_NUMBER_BEFORE_RE.exec(before);
    if (numbered && YEARS_THEN_EXPERIENCE_RE.test(text.slice(m.index, m.index + 160))) {
      a = numberOf(numbered[1]);
      b = numberOf(numbered[2]);
    } else {
      const reversed = EXPERIENCE_THEN_NUMBER_RE.exec(before);
      if (!reversed) return;
      a = numberOf(reversed[1]);
      b = numberOf(reversed[2]);
    }
    const min = a !== undefined && b !== undefined ? Math.min(a, b) : a;
    if (min !== undefined) out.push(min);
  });
  return out;
}

function descriptionSignals(description: string | null | undefined): Signal[] {
  if (typeof description !== 'string' || !description.trim()) return [];
  const text = prepareDescription(description);
  const out: Signal[] = [];
  const anchors = new Set<string>();
  execAll(DESCRIPTION_ANCHOR_RE, text, (m) => {
    for (const n of NEEDLE_PREFIXES.get(m[0]) ?? []) anchors.add(n);
  });
  for (const cue of DESCRIPTION_CUES) {
    if (cue.needles.some((n) => anchors.has(n)) && cue.re.test(text)) {
      out.push({ level: cue.level, confidence: 'low', reason: `description: ${cue.label}`, source: 'description' });
    }
  }
  let maxMin: number | undefined;
  for (const min of experienceYears(text)) {
    // > 15 is almost always company boilerplate ("our 25 years of experience"), not a requirement.
    if (min > 15) continue;
    maxMin = maxMin === undefined ? min : Math.max(maxMin, min);
  }
  if (maxMin !== undefined) {
    out.push({
      level: yearsLevel(maxMin),
      confidence: 'low',
      reason: `description: ${maxMin}+ years of experience`,
      source: 'description',
      years: maxMin,
    });
  }
  return out;
}

// ─── Combination ─────────────────────────────────────────────────────────────

type Relation = 'agree' | 'neutral' | 'conflict';

/** Years are a lower bound, so they only conflict with a much more junior (or 0–1 vs senior+) title. */
function yearsRelation(level: Level, years: number): Relation {
  const yl = yearsLevel(years);
  if (yl === level) return 'agree';
  const r = RANK[level];
  if (yl === 'entry') return r >= RANK.senior ? 'conflict' : 'neutral';
  if (yl === 'mid') return r <= RANK.new_grad ? 'conflict' : 'neutral';
  return r <= RANK.entry ? 'conflict' : 'neutral';
}

function relation(level: Level, s: Signal): Relation {
  if (s.years !== undefined) return yearsRelation(level, s.years);
  if (s.level === level) return 'agree';
  return Math.abs(RANK[level] - RANK[s.level]) >= 2 ? 'conflict' : 'neutral';
}

function pickByPrecedence(signals: Signal[]): Signal {
  return resolve(signals)!.signal;
}

function dedupe(reasons: string[]): string[] {
  return [...new Set(reasons)].slice(0, MAX_REASONS);
}

/**
 * Classify one posting. Pure and total: any input (including `null` fields or garbage) yields a
 * verdict, and the same input always yields the same verdict.
 */
export function classifyCareerLevel(input: CareerLevelInput | null | undefined): CareerLevelVerdict {
  try {
    return classifyInternal(input ?? {});
  } catch {
    // Defensive: the rules are total, but a classifier must never take a search down.
    return { level: 'unknown', confidence: 'low', reasons: ['classifier error'] };
  }
}

function classifyInternal(input: CareerLevelInput): CareerLevelVerdict {
  const title = typeof input.title === 'string' ? input.title : '';
  // analyzeTitle cuts an over-long title at MAX_TITLE_CHARS, at a word boundary.
  const t = analyzeTitle(title, 'title');
  const titleResolved = resolve(t.signals);
  const structured = structuredSignals(input);
  const described = descriptionSignals(input.description);

  let primary: Signal;
  let secondary: Signal[];
  const extra: string[] = [];
  if (titleResolved) {
    primary = titleResolved.signal;
    secondary = [...structured, ...described];
    for (const w of titleResolved.dropped) {
      t.notes.push(`ignored ${quote(w.cue ?? '')} (an explicit level in the title)`);
    }
    // An internship title that also says "new grad" ("Intern / New Grad") is genuinely mixed.
    if (primary.level === 'internship' && titleResolved.also.some((s) => s.level === 'new_grad')) {
      primary = { ...primary, confidence: down(primary.confidence) };
      extra.push('title also mentions new grad');
    }
  } else if (structured.length) {
    primary = pickByPrecedence(structured);
    secondary = [...structured.filter((s) => s !== primary), ...described];
  } else if (described.length) {
    primary = { ...pickByPrecedence(described), confidence: 'low' };
    secondary = described.filter((s) => s.reason !== primary.reason);
  } else {
    return {
      level: 'unknown',
      confidence: 'low',
      reasons: dedupe([...t.notes, 'no seniority signal in title, source fields or description']),
    };
  }

  let confidence = primary.confidence;
  let agreedStructured: Signal | undefined;
  let agreedDescription: Signal | undefined;
  let conflict: Signal | undefined;
  for (const s of secondary) {
    const rel = relation(primary.level, s);
    if (rel === 'agree') {
      if (s.source === 'description') agreedDescription ??= s;
      else agreedStructured ??= s;
    } else if (rel === 'conflict') {
      conflict ??= s;
    }
  }
  if (agreedStructured) {
    confidence = up(confidence);
    extra.push(`corroborated by ${agreedStructured.reason}`);
  } else if (agreedDescription && confidence === 'low' && primary.source !== 'description') {
    // Two cues from the same description are not independent evidence; only a description that
    // agrees with a weak title/structured signal lifts it.
    confidence = 'medium';
    extra.push(`corroborated by ${agreedDescription.reason}`);
  }
  if (conflict) {
    confidence = down(confidence);
    extra.push(`conflict: ${conflict.reason} suggests ${conflict.level}`);
  }
  // Guard notes only matter when they changed what an early-career cue would have said.
  const notes = primary.level === 'internship' || primary.level === 'new_grad' ? [] : t.notes;
  return {
    level: primary.level,
    confidence,
    reasons: dedupe([primary.reason, ...extra, ...notes]),
  };
}
