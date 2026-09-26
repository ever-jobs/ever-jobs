/**
 * Pure mapping helpers for the bdjobs.com JSON API (Spec 1711).
 *
 * Nothing here performs I/O, reads the clock (callers pass `nowMs`) or builds
 * a `Date` from free text: `new Date('Sep 23, 2026')` is parsed in the host
 * time zone, so a posting date could shift by a day depending on where the
 * scraper runs.
 */
import {
  CompensationDto,
  CompensationInterval,
  DescriptionFormat,
  JobPostDto,
  JobType,
  LocationDto,
  ScrapeDiagnostics,
  Site,
  getCompensationInterval,
  getJobTypeFromString,
  looksLikeChallenge,
} from '@ever-jobs/models';
import {
  extractEmails,
  htmlToPlainText,
  markdownConverter,
  parseLocationList,
  parseLocationText,
} from '@ever-jobs/common';
import {
  BDJOBS_COUNTRY_CODE,
  BDJOBS_COUNTRY_NAME,
  BDJOBS_CURRENCY,
  BDJOBS_JOB_URL_BASE,
  BdjobsMode,
} from './bdjobs.constants';
import {
  BdjobsDetail,
  BdjobsListItem,
  BdjobsSearchResponse,
} from './bdjobs.types';

// ── small value helpers ─────────────────────────────────────────────────────

/** Trimmed string, or '' for anything that is not a string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A non-negative integer from a number or an all-digit string; else null. */
function toInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  const s = text(value);
  if (!/^\d{1,9}$/.test(s)) return null;
  return Number(s);
}

/** The job id as a digits-only string, or null. */
export function bdjobsJobId(value: unknown): string | null {
  const s = typeof value === 'number' ? String(value) : text(value);
  return /^\d{1,12}$/.test(s) ? s : null;
}

/** Public job page for an id. */
export function bdjobsJobUrl(id: string): string {
  return `${BDJOBS_JOB_URL_BASE}${id}`;
}

function isAbsoluteHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── strategy switch ─────────────────────────────────────────────────────────

const HTML_MODE_VALUES = new Set(['html', 'legacy', 'legacy-html']);
const API_MODE_VALUES = new Set(['api', 'json']);

/**
 * Resolve the scrape strategy from the environment. `BDJOBS_MODE` wins;
 * `BDJOBS_STRATEGY` is read only when it is unset. Anything unrecognised
 * resolves to `api` and is reported back so the caller can warn once.
 */
export function resolveBdjobsMode(
  env: Record<string, string | undefined>,
): { mode: BdjobsMode; unrecognised: string | null } {
  const primary = env.BDJOBS_MODE;
  const raw = primary !== undefined && primary.trim() !== '' ? primary : env.BDJOBS_STRATEGY;
  const value = (raw ?? '').trim().toLowerCase();
  if (!value || API_MODE_VALUES.has(value)) return { mode: 'api', unrecognised: null };
  if (HTML_MODE_VALUES.has(value)) return { mode: 'html', unrecognised: null };
  return { mode: 'api', unrecognised: value.slice(0, 40) };
}

// ── dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** `YYYY-MM-DD` from numeric parts, or null for an impossible calendar date. */
function formatYmd(year: number, month: number, day: number): string | null {
  if (year < 1990 || year > 2999) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function monthNumber(name: string): number | null {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? null;
}

/**
 * The leading calendar date of an ISO-8601 value (`2026-09-23T10:10:00Z` →
 * `2026-09-23`), kept verbatim as the source wrote it. Anything that does not
 * start with a valid `YYYY-MM-DD` returns null; it never falls back to
 * `new Date(text)`.
 */
export function isoDateOnly(value: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(text(value));
  if (!m) return null;
  return formatYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * `MMM dd, yyyy` (also the full month name) → `YYYY-MM-DD`, built from the
 * captured parts, so the result cannot move with the host time zone.
 */
export function parseMonthDayYear(value: unknown): string | null {
  const s = text(value);
  if (s.length > 40) return null;
  const m = /^([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s.replace(/\s+/g, ' '));
  if (!m) return null;
  const month = monthNumber(m[1]);
  return month ? formatYmd(Number(m[3]), month, Number(m[2])) : null;
}

/**
 * Any of the board's calendar-date layouts (`BDJOBS_DATE_FORMATS`) →
 * `YYYY-MM-DD`: `MMM dd, yyyy`, `MMMM dd, yyyy`, `dd MMM yyyy`,
 * `dd-MMM-yyyy`, `dd MMMM yyyy`, `dd/MM/yyyy`, or an ISO date. Day-first for
 * the numeric form, as the board writes it. Never constructs a `Date`.
 */
export function parseBdjobsCalendarDate(value: unknown): string | null {
  const s = text(value).replace(/\s+/g, ' ');
  if (!s || s.length > 40) return null;

  const iso = isoDateOnly(s);
  if (iso) return iso;

  const monthFirst = parseMonthDayYear(s);
  if (monthFirst) return monthFirst;

  const dayFirst = /^(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*\.?,?[ -](\d{4})$/.exec(s);
  if (dayFirst) {
    const month = monthNumber(dayFirst[2]);
    return month ? formatYmd(Number(dayFirst[3]), month, Number(dayFirst[1])) : null;
  }

  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (numeric) {
    return formatYmd(Number(numeric[3]), Number(numeric[2]), Number(numeric[1]));
  }
  return null;
}

/**
 * The posting instant in epoch ms for the `hoursOld` filter, only for an ISO
 * value that carries a time and a zone. Null when there is none, so the caller
 * keeps the row rather than guess.
 */
export function publishInstantMs(value: unknown): number | null {
  const s = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    return null;
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// ── salary ──────────────────────────────────────────────────────────────────

const SALARY_RE =
  /^\s*Tk\.?\s*([\d,]+)(?:\s*-\s*([\d,]+))?\s*\((Monthly|Yearly|Hourly|Daily|Weekly)\)\s*$/i;

export interface BdjobsSalary {
  interval: CompensationInterval;
  minAmount: number;
  maxAmount: number;
}

function toAmount(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  const digits = text(raw).replace(/,/g, '');
  if (!/^\d{1,12}$/.test(digits)) return null;
  const n = Number(digits);
  return n > 0 ? n : null;
}

/**
 * `Tk. 35000 - 50000 (Monthly)` → `{ monthly, 35000, 50000 }`. A single figure
 * sets min = max; commas (including lakh grouping, `1,20,000`) are stripped.
 * `--`, empty, `Negotiable` and anything else return null.
 */
export function parseBdjobsSalary(value: unknown): BdjobsSalary | null {
  const s = text(value);
  if (!s || s.length > 120) return null;
  const m = SALARY_RE.exec(s);
  if (!m) return null;
  const first = toAmount(m[1]);
  const second = m[2] !== undefined ? toAmount(m[2]) : first;
  if (first === null || second === null) return null;
  const interval = getCompensationInterval(m[3].toLowerCase());
  if (!interval) return null;
  return {
    interval,
    minAmount: Math.min(first, second),
    maxAmount: Math.max(first, second),
  };
}

function toCompensation(salary: BdjobsSalary | null): CompensationDto | null {
  if (!salary) return null;
  return new CompensationDto({
    currency: BDJOBS_CURRENCY,
    interval: salary.interval,
    minAmount: salary.minAmount,
    maxAmount: salary.maxAmount,
  });
}

/**
 * Salary from the details payload: its numeric min/max win when `ShowSalary`
 * is '1', with the interval from its own range text or, failing that, the
 * list salary. Without a known interval nothing is invented: null.
 */
export function detailSalary(detail: BdjobsDetail, listSalary: BdjobsSalary | null): BdjobsSalary | null {
  const rangeSalary = parseBdjobsSalary(detail.JobSalaryRange);
  if (text(detail.ShowSalary) !== '1') return rangeSalary;
  const min = toAmount(detail.JobSalaryMinSalary);
  const max = toAmount(detail.JobSalaryMaxSalary);
  const interval = rangeSalary?.interval ?? listSalary?.interval ?? null;
  if ((min === null && max === null) || !interval) return rangeSalary;
  const lo = min ?? max!;
  const hi = max ?? min!;
  return { interval, minAmount: Math.min(lo, hi), maxAmount: Math.max(lo, hi) };
}

// ── job type ────────────────────────────────────────────────────────────────

/** Long forms the details `JobNature` uses that the shared lookup does not know. */
const JOB_NATURE_ALIASES: Record<string, JobType> = {
  contractual: JobType.CONTRACT,
  'full time': JobType.FULL_TIME,
  'part time': JobType.PART_TIME,
  internship: JobType.INTERNSHIP,
  freelance: JobType.CONTRACT,
};

/**
 * A list `JobType` ('FullTime', 'Contract') or details `JobNature`
 * ('Contractual', 'Full Time') → `[JobType]`. A comma list maps each part.
 * Unknown values give null.
 */
export function mapJobType(value: unknown): JobType[] | null {
  const s = text(value);
  if (!s || s.length > 200) return null;
  const out: JobType[] = [];
  for (const part of s.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const type =
      getJobTypeFromString(token) ??
      JOB_NATURE_ALIASES[token.toLowerCase().replace(/[\s_-]+/g, ' ')] ??
      null;
    if (type && !out.includes(type)) out.push(type);
  }
  return out.length > 0 ? out : null;
}

// ── workplace ───────────────────────────────────────────────────────────────

export interface BdjobsWorkplace {
  isRemote: boolean;
  workFromHomeType: 'Remote' | 'Hybrid' | null;
}

/** Whether a workplace label names home working ('Home', 'Work from home'). */
export function isHomeWorkplace(value: unknown): boolean {
  return /\bhome\b|\bremote\b/i.test(text(value));
}

/**
 * Remote status comes only from the workplace field; a location of "Anywhere
 * in Bangladesh" is not remote. Home only → Remote; home and office → Hybrid
 * (not remote, the repo convention); anything else → not remote.
 */
export function mapWorkplace(value: unknown): BdjobsWorkplace {
  const s = text(value);
  const home = isHomeWorkplace(s);
  const office = /\boffice\b/i.test(s);
  if (/\bhybrid\b/i.test(s) || (home && office)) {
    return { isRemote: false, workFromHomeType: 'Hybrid' };
  }
  if (home) return { isRemote: true, workFromHomeType: 'Remote' };
  return { isRemote: false, workFromHomeType: null };
}

// ── location ────────────────────────────────────────────────────────────────

/**
 * The label handed to the shared location parser. Dhaka neighbourhood labels
 * ('GULSHAN 1') gain the country, so they parse as a city in Bangladesh;
 * 'Anywhere in Bangladesh' and an empty label become the country alone. A
 * label that already names a different country (an overseas posting) is kept
 * as it is.
 */
export function bdjobsLocationLabel(value: unknown): string {
  const raw = text(value).replace(/\s+/g, ' ');
  if (!raw || /^anywhere in bangladesh$/i.test(raw)) return BDJOBS_COUNTRY_NAME;
  if (/\bbangladesh$/i.test(raw)) return raw;
  const own = parseLocationText(raw).location?.country;
  if (typeof own === 'string' && own && !/^bangladesh$/i.test(own)) return raw;
  return `${raw}, ${BDJOBS_COUNTRY_NAME}`;
}

export interface BdjobsLocation {
  location: LocationDto;
  locations: LocationDto[];
  /** 'BD' when the location is in Bangladesh; null for an overseas posting. */
  countryCode: string | null;
}

/** `location` / `locations` / `countryCode` for a raw board location label. */
export function buildLocation(value: unknown): BdjobsLocation {
  const raw = text(value).replace(/\s+/g, ' ');
  const label = bdjobsLocationLabel(raw);
  const parsed = parseLocationList([label]);
  const base = parsed.location ?? parsed.locations[0] ?? null;
  const location = new LocationDto({
    ...(base ?? {}),
    country: base?.country ?? (label === raw ? null : BDJOBS_COUNTRY_NAME),
  });
  if (raw) location.text = raw;
  for (const key of Object.keys(location) as Array<keyof LocationDto>) {
    if (location[key] === undefined || location[key] === null) delete location[key];
  }
  const inBangladesh =
    typeof location.country === 'string' && /^bangladesh$/i.test(location.country);
  return {
    location,
    locations: [new LocationDto({ ...location })],
    countryCode: inBangladesh ? BDJOBS_COUNTRY_CODE : null,
  };
}

// ── skills / emails ─────────────────────────────────────────────────────────

/** Comma lists → trimmed, case-insensitively de-duplicated skills; null if none. */
export function splitSkills(...lists: unknown[]): string[] | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const part of text(list).split(',')) {
      const skill = part.trim().replace(/\s+/g, ' ');
      if (!skill || skill.length > 100) continue;
      const key = skill.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(skill);
    }
  }
  return out.length > 0 ? out : null;
}

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/** Union of email lists and single addresses, de-duplicated case-insensitively. */
export function mergeEmails(...sources: Array<string[] | string | null | undefined>): string[] | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    const values = Array.isArray(source) ? source : [source];
    for (const value of values) {
      const email = text(value);
      if (!email || !EMAIL_RE.test(email)) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
  }
  return out.length > 0 ? out : null;
}

// ── description ─────────────────────────────────────────────────────────────

const BLOCK_TAG = '(?:ul|ol|li|p|div|h[1-6]|table|thead|tbody|tr|blockquote)';
const NEWLINE_BEFORE_BLOCK = new RegExp(`\\n(?=<\\/?${BLOCK_TAG}\\b)`, 'gi');
const NEWLINE_AFTER_BLOCK = new RegExp(`(<\\/${BLOCK_TAG}>|<br\\s*\\/?>)\\n`, 'gi');

/**
 * One description section as HTML. Plain text (the education field is often
 * newline-separated lines) is escaped and its line breaks kept as `<br>`;
 * markup keeps its own structure, with only the newlines that sit in running
 * text turned into `<br>`. Every regex here is linear: whitespace around a
 * newline is collapsed first, so no pattern has to backtrack across a run.
 */
export function sectionHtml(value: unknown): string | null {
  const collapsed = text(value).replace(/[ \t\r\f\v]*\n\s*/g, '\n');
  if (!collapsed) return null;
  if (!/<[a-z][^>]*>/i.test(collapsed)) {
    return `<p>${escapeHtml(collapsed).replace(/\n/g, '<br>')}</p>`;
  }
  return collapsed
    .replace(NEWLINE_BEFORE_BLOCK, '')
    .replace(NEWLINE_AFTER_BLOCK, '$1')
    .replace(/\n/g, '<br>');
}

/**
 * The full description from a details payload, sections in order and empty
 * ones skipped: the body, Context, Education, Experience, Additional
 * requirements, Benefits, then a Deadline line (the DTO has no deadline field).
 * The list's `jobDescription` is never used: it is a truncated copy of the
 * education field.
 */
export function buildDescriptionHtml(detail: BdjobsDetail, item: BdjobsListItem): string | null {
  const parts: string[] = [];
  const body = sectionHtml(detail.JobDescription);
  if (body) parts.push(body);

  const sections: Array<[string, unknown]> = [
    ['Context', text(detail.Context) || item.jobContext],
    ['Education', text(detail.EducationRequirements) || item.eduRec],
    ['Experience', detail.experience],
    ['Additional requirements', detail.AdditionJobRequirements],
    ['Benefits', detail.JobOtherBenifits],
  ];
  for (const [heading, value] of sections) {
    const html = sectionHtml(value);
    if (html) parts.push(`<h2>${heading}</h2>${html}`);
  }
  if (parts.length === 0) return null;

  const deadline = text(detail.Deadline) || text(item.deadline);
  if (deadline && deadline.length <= 40) {
    parts.push(`<p>Deadline: ${escapeHtml(deadline)}</p>`);
  }
  return parts.join('\n');
}

/**
 * Render HTML in the requested format: HTML passes through, PLAIN is stripped
 * to text, MARKDOWN (and an unset format, the DTO default) is converted.
 */
export function formatDescription(html: string | null, format?: DescriptionFormat): string | null {
  if (!html) return null;
  if (format === DescriptionFormat.HTML) return html;
  if (format === DescriptionFormat.PLAIN) return htmlToPlainText(html) || null;
  return markdownConverter(html) ?? html;
}

// ── list and details mapping ────────────────────────────────────────────────

function listVacancies(value: unknown): number | null {
  const n = toInt(value);
  return n !== null && n > 0 ? n : null;
}

export interface MapListItemOptions {
  /** The row came from `premiumData`. */
  fromPremium?: boolean;
  format?: DescriptionFormat;
}

/**
 * Map one search row to a `JobPostDto` from list fields alone. Returns null
 * when the row has no usable id or no title in either language.
 */
export function mapListItem(item: BdjobsListItem, options: MapListItemOptions = {}): JobPostDto | null {
  if (!item || typeof item !== 'object') return null;
  const id = bdjobsJobId(item.Jobid);
  if (!id) return null;
  const title = text(item.jobTitle) || text(item.JobTitleBng);
  if (!title) return null;

  const workplace = mapWorkplace(item.WorkPlace);
  const loc = buildLocation(item.location);
  const context = text(item.jobContext);
  const experience = text(item.experience);
  const logo = text(item.logoUrl);
  const premium = options.fromPremium === true || text(item.AdType) === '2';

  return new JobPostDto({
    id,
    site: Site.BDJOBS,
    title,
    companyName: text(item.companyName) || null,
    jobUrl: bdjobsJobUrl(id),
    location: loc.location,
    locations: loc.locations,
    ...(loc.countryCode ? { countryCode: loc.countryCode } : {}),
    datePosted: isoDateOnly(item.publishDate),
    compensation: toCompensation(parseBdjobsSalary(item.Salary)),
    jobType: mapJobType(item.JobType),
    isRemote: workplace.isRemote,
    ...(workplace.workFromHomeType ? { workFromHomeType: workplace.workFromHomeType } : {}),
    description: context ? formatDescription(context, options.format) : null,
    emails: context ? mergeEmails(extractEmails(context)) : null,
    ...(experience && !/^n\/?a$/i.test(experience) ? { experienceRange: experience } : {}),
    vacancyCount: listVacancies(item.Vacancies),
    ...(logo && isAbsoluteHttpUrl(logo) ? { companyLogo: logo } : {}),
    ...(premium ? { listingType: 'premium' } : {}),
  });
}

/** Longest `CompanyBusiness` value still read as an industry label. */
const BDJOBS_INDUSTRY_MAX_LENGTH = 150;

function companyWebsite(value: unknown): string | null {
  const s = text(value);
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s.replace(/^\/\//, '')}`;
  return isAbsoluteHttpUrl(candidate) ? candidate : null;
}

/**
 * Enrich a list-mapped job with its details payload. List values win where
 * both exist, except the salary (the details figures are authoritative when
 * shown) and the vacancy count (the details '--' means "not stated", and the
 * list's 1 for the same job looks like a default).
 */
export function applyDetails(
  job: JobPostDto,
  item: BdjobsListItem,
  detail: BdjobsDetail,
  format?: DescriptionFormat,
): JobPostDto {
  if (!text(job.title)) {
    const title = text(detail.JobTitle);
    if (title) job.title = title;
  }
  if (!job.companyName) {
    job.companyName = text(detail.CompanyNameENG) || text(detail.CompnayName) || null;
  }

  const applyUrl = text(detail.ApplyURL);
  if (applyUrl && isAbsoluteHttpUrl(applyUrl)) job.applyUrl = applyUrl;

  if (!job.datePosted) job.datePosted = parseMonthDayYear(detail.PostedOn);

  const salary = detailSalary(detail, parseBdjobsSalary(item.Salary));
  if (salary) job.compensation = toCompensation(salary);

  if (!job.jobType) job.jobType = mapJobType(detail.JobNature);

  if (!text(item.WorkPlace) && text(detail.JobWorkPlace)) {
    const workplace = mapWorkplace(detail.JobWorkPlace);
    job.isRemote = workplace.isRemote;
    if (workplace.workFromHomeType) job.workFromHomeType = workplace.workFromHomeType;
  }

  if (!text(item.location) && text(detail.JobLocation)) {
    const loc = buildLocation(detail.JobLocation);
    job.location = loc.location;
    job.locations = loc.locations;
    if (loc.countryCode) job.countryCode = loc.countryCode;
  }

  const html = buildDescriptionHtml(detail, item);
  if (html) job.description = formatDescription(html, format);
  // Emails come from the HTML, not the converted text: the markdown converter
  // escapes underscores, which would cut `first_last@x.com` short.
  job.emails = mergeEmails(job.emails ?? null, html ? extractEmails(html) : null, text(detail.ApplyEmail));

  const skills = splitSkills(detail.SuggestedSkills, detail.SkillsRequired);
  if (skills) job.skills = skills;

  const vacancies =
    typeof detail.JobVacancies === 'number' ? String(detail.JobVacancies) : text(detail.JobVacancies);
  if (vacancies) job.vacancyCount = listVacancies(vacancies);

  const website = companyWebsite(detail.CompanyWeb);
  if (website) job.companyUrl = website;
  const address = text(detail.CompanyAddress);
  if (address && text(detail.CompanyHideAddress).toLowerCase() !== 'true') {
    job.companyAddresses = address;
  }
  // `CompanyBusiness` is usually a short line of business ("Apartment Sales."),
  // but some employers fill it with a multi-paragraph company profile. A
  // profile is a description, not an industry.
  const business = text(detail.CompanyBusiness);
  if (business && business.length <= BDJOBS_INDUSTRY_MAX_LENGTH && !business.includes('\n')) {
    job.companyIndustry = business;
  } else if (business && !job.companyDescription) {
    job.companyDescription = business;
  }

  return job;
}

// ── response interpretation ─────────────────────────────────────────────────

/** Parse a string body that should have been JSON; null when it is not. */
function parseJsonBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  const s = body.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export interface BdjobsSearchRow {
  item: BdjobsListItem;
  premium: boolean;
}

export type BdjobsSearchPage =
  | {
      kind: 'ok';
      /** Premium rows first (as the board shows them), then the page rows. */
      rows: BdjobsSearchRow[];
      totalPages: number | null;
      totalRecords: number | null;
    }
  | { kind: 'error'; diagnostics: ScrapeDiagnostics };

/**
 * Judge a search response by its shape, not its `statuscode` (search says '1'
 * and details says '0' for the same success). A 200 that is not JSON is the
 * silent failure this plugin used to have, so it becomes a diagnostic.
 */
export function interpretSearchBody(body: unknown): BdjobsSearchPage {
  const parsed = parseJsonBody(body);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (typeof body === 'string' && looksLikeChallenge(body)) {
      return { kind: 'error', diagnostics: new ScrapeDiagnostics('blocked', 'challenge page instead of JSON') };
    }
    return {
      kind: 'error',
      diagnostics: new ScrapeDiagnostics('fetch_error', 'unexpected non-JSON search response'),
    };
  }
  const response = parsed as BdjobsSearchResponse;
  if (!Array.isArray(response.data)) {
    const keys = Object.keys(response).slice(0, 10).join(', ') || '(none)';
    return {
      kind: 'error',
      diagnostics: new ScrapeDiagnostics('unknown', `unexpected search response shape: ${keys}`),
    };
  }
  const premium = Array.isArray(response.premiumData) ? response.premiumData : [];
  const rows: BdjobsSearchRow[] = [
    ...premium.filter((item) => item && typeof item === 'object').map((item) => ({ item, premium: true })),
    ...response.data.filter((item) => item && typeof item === 'object').map((item) => ({ item, premium: false })),
  ];
  return {
    kind: 'ok',
    rows,
    totalPages: toInt(response.common?.totalpages),
    totalRecords: toInt(response.common?.total_records_found),
  };
}

export type BdjobsDetailOutcome =
  | { kind: 'ok'; detail: BdjobsDetail }
  | { kind: 'not_found' }
  | { kind: 'closed' }
  | { kind: 'malformed' };

/** Judge a details response by shape: `data[0].JobFound === 'True'`. */
export function interpretDetailBody(body: unknown): BdjobsDetailOutcome {
  const parsed = parseJsonBody(body) as { data?: unknown } | null;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.data)) {
    return { kind: 'malformed' };
  }
  const detail = parsed.data[0] as BdjobsDetail | undefined;
  if (!detail || typeof detail !== 'object') return { kind: 'not_found' };
  if (text(detail.JobFound).toLowerCase() !== 'true') return { kind: 'not_found' };
  const closed = detail.Closed;
  if (closed === true || closed === 1 || /^(1|true)$/i.test(text(closed))) return { kind: 'closed' };
  return { kind: 'ok', detail };
}
