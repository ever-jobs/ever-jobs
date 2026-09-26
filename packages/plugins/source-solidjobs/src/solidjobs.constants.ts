export const SOLIDJOBS_API_URL = 'https://solid.jobs/public-api/offers';

/**
 * The `campaign` query parameter is mandatory — the server replies
 * HTTP 400 without it (lowercase letters, numbers and dashes,
 * max 64 chars). The value is echoed into returned offer URLs as a
 * referral suffix. Verified live on 2026-06-11.
 */
export const SOLIDJOBS_CAMPAIGN = 'api';

/** First division in the default scan order (Spec 718's only division). */
export const SOLIDJOBS_DEFAULT_DIVISION = 'it';

/**
 * Every public division, in default scan order: largest first, by the live
 * totals of 2026-09-24 (it 1707, sales 763, marketing 294, logistics 248,
 * finances 235, engineering 234, other 174, hr 107). Spec 1709.
 */
export const SOLIDJOBS_DIVISIONS_ALL: readonly string[] = [
  'it',
  'sales',
  'marketing',
  'logistics',
  'finances',
  'engineering',
  'other',
  'hr',
];

/**
 * Env var holding a comma-separated division list. When set it replaces the
 * default scan list and is used in the operator's order (search-term hints
 * never reorder it). `SOLIDJOBS_DIVISIONS=it` restores the Spec 718 scope.
 */
export const SOLIDJOBS_DIVISIONS_ENV = 'SOLIDJOBS_DIVISIONS';

/**
 * Env switch for paging (Spec 1709). On by default: every request carries
 * `pageSize` and `pageIndex` and a division is paged until it is exhausted or
 * enough offers are collected. `false` / `0` / `no` / `off` restores the
 * Spec 718 request: one `?campaign=api` call per division, which the server
 * answers with its default page of at most 500 offers.
 */
export const SOLIDJOBS_PAGINATE_ENV = 'SOLIDJOBS_PAGINATE';

/**
 * Env switch for search-term matching (Spec 1709). `tokens` (default): every
 * whitespace/`/`/`,`-separated token of the diacritic-folded term must occur
 * in the offer's title, company, division, category, sub-category, experience
 * level or a skill name. `phrase` (alias `legacy`) restores the Spec 718
 * matcher: the whole term, lower-cased, as one substring of the title,
 * category, sub-category or a single skill name.
 */
export const SOLIDJOBS_SEARCH_MODE_ENV = 'SOLIDJOBS_SEARCH_MODE';

/**
 * Env switch for the client-side `location`, `isRemote`, `jobType` and
 * `hoursOld` filters (Spec 1709). On by default. `false` / `0` / `no` /
 * `off` ignores those four inputs again, as Spec 718 did; `searchTerm` and
 * `offset` are still honoured.
 */
export const SOLIDJOBS_INPUT_FILTERS_ENV = 'SOLIDJOBS_INPUT_FILTERS';

/** Env override (milliseconds) for {@link SOLIDJOBS_TIME_BUDGET_MS}. */
export const SOLIDJOBS_TIME_BUDGET_ENV = 'SOLIDJOBS_TIME_BUDGET_MS';

export const SOLIDJOBS_DEFAULT_RESULTS = 100;

/** Largest `pageSize` the server accepts; it is also the server default. */
export const SOLIDJOBS_MAX_PAGE_SIZE = 500;

/**
 * Hard cap on pages per division (10 000 offers at the largest page size).
 * Guards against a server that ignores `pageIndex` or reports a runaway
 * `totalPages`.
 */
export const SOLIDJOBS_MAX_PAGES_PER_DIVISION = 20;

/**
 * Divisions fetched at the same time. Pages within one division are always
 * sequential, so at most this many requests are in flight to solid.jobs.
 */
export const SOLIDJOBS_DIVISION_CONCURRENCY = 2;

/**
 * Wall-clock budget for one scrape. The server answers in about 9-10 s per
 * request (live, 2026-09-24), so this stops starting new pages well inside the
 * API's 120 s fan-out deadline and reports a `partial` diagnostic instead of
 * being abandoned.
 */
export const SOLIDJOBS_TIME_BUDGET_MS = 90_000;

/** Board-level country: every offer on the board is in Poland. */
export const SOLIDJOBS_COUNTRY_CODE = 'PL';

/**
 * Search-term stems (diacritic-folded, lower-case) that move a division to
 * the front of the scan order. A stem matches at the start of a word of the
 * folded term. Reorders only — every division stays eligible. Deliberately
 * leaves out ambiguous stems ('engineer', 'support', 'analyst') that also
 * label IT roles.
 */
export const SOLIDJOBS_DIVISION_HINTS: Readonly<Record<string, readonly string[]>> = {
  sales: [
    'sales',
    'sprzeda',
    'handlow',
    'account manager',
    'key account',
    'business development',
    'customer success',
  ],
  marketing: [
    'marketing',
    'seo',
    'sem',
    'content',
    'social media',
    'brand',
    'copywrit',
    'grafik',
    'graphic',
  ],
  hr: ['hr', 'rekrut', 'recruit', 'kadr', 'talent'],
  logistics: [
    'logist',
    'magazyn',
    'warehouse',
    'spedy',
    'forwarder',
    'kierowc',
    'driver',
    'supply chain',
    'zakup',
    'purchas',
  ],
  finances: [
    'financ',
    'finans',
    'ksiegow',
    'accountant',
    'controll',
    'kontrol',
    'audyt',
    'audit',
    'podat',
    'tax',
  ],
  engineering: [
    'inzynier',
    'mechani',
    'automatyk',
    'elektry',
    'konstrukt',
    'cad',
    'produkc',
    'utrzyman',
    'budow',
    'technolog',
  ],
  it: [
    'developer',
    'programist',
    'java',
    'python',
    'javascript',
    'typescript',
    'react',
    'angular',
    '.net',
    'devops',
    'tester',
    'qa',
    'frontend',
    'backend',
    'fullstack',
    'data',
    'cloud',
    'sql',
    'php',
    'golang',
    'android',
    'ios',
  ],
};

/**
 * Contract-form codes carried in `salary.employmentType`, emitted verbatim in
 * `JobPostDto.employmentType`:
 *
 * - `UoP` — umowa o pracę, an employment contract;
 * - `UZ`  — umowa zlecenie, a contract of mandate;
 * - `UoD` — umowa o dzieło, a contract for a specific task;
 * - `B2B` — the worker invoices as their own business.
 *
 * All but `UoP` are contractor-style engagements, so a `JobType.CONTRACT`
 * filter keeps an offer whose primary or secondary salary uses one of these.
 */
export const SOLIDJOBS_CONTRACT_FORMS: ReadonlySet<string> = new Set(['B2B', 'UZ', 'UoD']);

/**
 * Honest crawler identity. Served by the board without a challenge
 * (live, 2026-09-24). A caller's `userAgent` input still takes precedence.
 */
export const SOLIDJOBS_USER_AGENT =
  'Mozilla/5.0 (compatible; EverJobs/1.0; +https://github.com/ever-jobs/ever-jobs)';

/**
 * Request headers. The User-Agent is not pinned here any more: it goes
 * through `createHttpClient({ userAgent })`, so `input.userAgent` is honoured.
 */
export const SOLIDJOBS_HEADERS: Record<string, string> = {
  Accept: 'application/json',
};

/** English (and German) city names a caller may type, folded, to the board's Polish spelling. */
export const SOLIDJOBS_CITY_EXONYMS: Readonly<Record<string, string>> = {
  warsaw: 'warszawa',
  cracow: 'krakow',
  breslau: 'wroclaw',
  danzig: 'gdansk',
};

/** Folded location labels that name the whole country or remote work, not a place. */
export const SOLIDJOBS_COUNTRY_LEVEL_LABELS: ReadonlySet<string> = new Set([
  'polska',
  'poland',
  'cala polska',
  'pl',
  'zdalnie',
  'praca zdalna',
  'remote',
]);

/** Folded location needles that ask for remote offers rather than a place. */
export const SOLIDJOBS_REMOTE_NEEDLES: ReadonlySet<string> = new Set([
  'remote',
  'zdalnie',
  'praca zdalna',
]);
