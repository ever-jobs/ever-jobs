import * as cheerio from 'cheerio';
import {
  CompensationDto,
  CompensationInterval,
  JobType,
  ScrapeDiagnostics,
  getJobTypeFromString,
} from '@ever-jobs/models';
import { intervalFromPeriodToken, parseSalaryNumber } from '@ever-jobs/common';
import {
  JOB_TYPE_CODES,
  LINKEDIN_BASE_URL,
  LINKEDIN_BLOCK_STATUS,
  LINKEDIN_BLOCK_URL_RE,
  LINKEDIN_CURRENCY_PREFIXES,
  LINKEDIN_FETCH_COMPANY_DETAILS_ENV,
  LINKEDIN_LEGACY_ENV,
  LINKEDIN_MEDIA_HOST,
} from './linkedin.constants';
import type { ApplicantsInfo, LinkedInLegacyFlags, LinkedInScraperInput } from './linkedin.types';

/**
 * Get LinkedIn job type filter code from a JobType enum.
 */
export function jobTypeCode(jobType: JobType): string | null {
  return JOB_TYPE_CODES[jobType] ?? null;
}

export interface ParseJobTypeOptions {
  /**
   * Resolve every criterion value, as the plugin did before Spec 1701. That
   * turns Seniority `Internship` into INTERNSHIP and Job function `Other` into
   * OTHER, so it is off by default.
   */
  allCriteria?: boolean;
}

/**
 * Parse the job type from the criteria list. Only the value under the
 * "Employment type" subheader is read (Spec 1701); `{ allCriteria: true }`
 * restores the old read of every criterion.
 */
export function parseJobType(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<any>,
  options: ParseJobTypeOptions = {},
): JobType[] | null {
  if (options.allCriteria) {
    const criteriaItems = el.find('.description__job-criteria-text');
    const result: JobType[] = [];
    criteriaItems.each((_, item) => {
      const text = $(item).text().trim().toLowerCase().replace(/[-\s]/g, '');
      const jt = getJobTypeFromString(text);
      if (jt) result.push(jt);
    });
    return result.length > 0 ? result : null;
  }
  const jt = jobTypeFromEmploymentType(parseCriteria($, el)['employment type']);
  return jt ? [jt] : null;
}

/** Resolve one "Employment type" label (`Full-time`, `Contract`, …). */
export function jobTypeFromEmploymentType(value: string | null | undefined): JobType | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return (
    getJobTypeFromString(value) ??
    getJobTypeFromString(value.trim().toLowerCase().replace(/[-\s]/g, ''))
  );
}

/**
 * Parse the job level (seniority) from an HTML element.
 */
export function parseJobLevel($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string | null {
  const header = el.find('.description__job-criteria-subheader');
  let result: string | null = null;
  header.each((_, item) => {
    const label = $(item).text().trim().toLowerCase();
    if (label === 'seniority level') {
      const value = $(item).next('.description__job-criteria-text').text().trim();
      if (value) result = value;
    }
  });
  return result;
}

/**
 * Parse the company industry from an HTML element.
 */
export function parseCompanyIndustry($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): string | null {
  const header = el.find('.description__job-criteria-subheader');
  let result: string | null = null;
  header.each((_, item) => {
    const label = $(item).text().trim().toLowerCase();
    if (label === 'industries') {
      const value = $(item).next('.description__job-criteria-text').text().trim();
      if (value) result = value;
    }
  });
  return result;
}

export interface IsJobRemoteOptions {
  /** The pre-Spec 1701 test: a bare substring match over title, description and location. */
  legacy?: boolean;
}

/**
 * Determine if a job is remote from its title and location.
 *
 * Since Spec 1701 this delegates to {@link detectRemoteSignal} over the title
 * and location only: `description` is accepted for compatibility and ignored,
 * because prose mentions "remote" for many reasons that are not a workplace.
 * `{ legacy: true }` restores the old substring test over all three.
 */
export function isJobRemote(
  title: string,
  description: string,
  locationStr: string,
  options: IsJobRemoteOptions = {},
): boolean {
  if (options.legacy) {
    const remoteKeywords = ['remote', 'work from home', 'wfh', 'telecommute'];
    const fullString = `${title} ${description} ${locationStr}`.toLowerCase();
    return remoteKeywords.some((kw) => fullString.includes(kw));
  }
  return detectRemoteSignal(title, locationStr);
}

/** Collapse whitespace runs (including newlines) to single spaces and trim. */
export function collapseWhitespace(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The criteria list as `{ [lower-cased subheader]: value }`, e.g.
 * `{ 'seniority level': 'Mid-Senior level', 'employment type': 'Full-time' }`.
 * The first occurrence of a subheader wins; empty values are skipped.
 */
export function parseCriteria($: cheerio.CheerioAPI, el: cheerio.Cheerio<any>): Record<string, string> {
  const criteria: Record<string, string> = {};
  el.find('.description__job-criteria-subheader').each((_, item) => {
    const label = collapseWhitespace($(item).text()).toLowerCase();
    if (!label || Object.prototype.hasOwnProperty.call(criteria, label)) return;
    const value = collapseWhitespace($(item).nextAll('.description__job-criteria-text').first().text());
    if (value) criteria[label] = value;
  });
  return criteria;
}

const JOB_URN_RE = /^urn:li:jobPosting:(\d+)$/;
const JOB_VIEW_ID_RE = /\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})(?:[/?#]|$)/;

/** The numeric posting id at the end of a `/jobs/view/<slug>-<id>` link, else `null`. */
export function jobIdFromHref(href: string | null | undefined): string | null {
  if (typeof href !== 'string') return null;
  return JOB_VIEW_ID_RE.exec(href)?.[1] ?? null;
}

/**
 * The numeric posting id of a search card: `data-entity-urn`
 * (`urn:li:jobPosting:<digits>`) on the card or inside it, falling back to the
 * trailing digits of the card link. `null` when neither carries one.
 */
export function extractLinkedInJobId(card: cheerio.Cheerio<any>): string | null {
  const urn = card.find('[data-entity-urn]').addBack('[data-entity-urn]').first().attr('data-entity-urn');
  const fromUrn = typeof urn === 'string' ? JOB_URN_RE.exec(urn.trim())?.[1] : undefined;
  if (fromUrn) return fromUrn;
  return jobIdFromHref(card.find('.base-search-card__full-link, a.base-card__full-link').first().attr('href'));
}

/** `https://www.linkedin.com/jobs/view/<id>`: served directly, no slug or tracking query. */
export function canonicalJobUrl(jobId: string): string {
  return `${LINKEDIN_BASE_URL}/jobs/view/${jobId}`;
}

const COMPANY_PATH_RE = /^(?:(?:https?:)?\/\/(?:[a-z0-9-]+\.)*linkedin\.com)?\/company\/([^/?#\s]+)/i;
const COMPANY_SLUG_RE = /^[A-Za-z0-9%._~-]+$/;

/** The company slug of a LinkedIn company link (any subdomain, with or without a query), else `null`. */
export function companySlugFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const slug = COMPANY_PATH_RE.exec(url.trim())?.[1];
  if (!slug || !COMPANY_SLUG_RE.test(slug) || /^\.+$/.test(slug)) return null;
  return slug;
}

/**
 * `https://www.linkedin.com/company/<slug>`: drops `?trk=…` and a regional
 * subdomain (`ca.linkedin.com`). A link that is not a LinkedIn company link is
 * returned trimmed and unchanged; an empty one gives `null`.
 */
export function normalizeCompanyUrl(href: string | null | undefined): string | null {
  const text = typeof href === 'string' ? href.trim() : '';
  if (!text) return null;
  const slug = companySlugFromUrl(text);
  return slug ? `${LINKEDIN_BASE_URL}/company/${slug}` : text;
}

function parseHttpUrl(value: string | null | undefined): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function isLinkedInHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

/** A real company logo URL on `media.licdn.com`; `null` for placeholders and anything else. */
export function licdnMediaUrl(value: string | null | undefined): string | null {
  const url = parseHttpUrl(value);
  return url && url.hostname.toLowerCase() === LINKEDIN_MEDIA_HOST ? value!.trim() : null;
}

/** An http(s) URL that is not on linkedin.com (a company website or an offsite apply link). */
export function externalHttpUrl(value: string | null | undefined): string | null {
  const url = parseHttpUrl(value);
  return url && !isLinkedInHost(url.hostname) ? value!.trim() : null;
}

/**
 * Unwrap `https://www.linkedin.com/redir/redirect?url=<target>&urlhash=…` to
 * its target. Any other value is returned trimmed and unchanged.
 */
export function unwrapLinkedInRedirect(href: string | null | undefined): string | null {
  const text = typeof href === 'string' ? href.trim() : '';
  if (!text) return null;
  const url = parseHttpUrl(text);
  if (url && isLinkedInHost(url.hostname) && url.pathname.replace(/\/+$/, '') === '/redir/redirect') {
    return url.searchParams.get('url')?.trim() || null;
  }
  return text;
}

// ── Pay (Spec 1701 §5.4) ─────────────────────────────────────────────────────

const PAY_MAX_LENGTH = 200;
const PAY_UP_TO_RE = /^up\s+to\s+/i;
const PAY_RANGE_SPLIT_RE = /\s*[-–—]\s*|\s+to\s+/i;
const PAY_ISO_PREFIX_RE = /^([A-Z]{3})\s?(?=\d)/;
const PAY_NUMBER_RE = /^(\d[\d,]*(?:\.\d+)?)\s*(?:([KkMm])(?![A-Za-z]))?/;
const PAY_PERIOD_TOKEN_RE =
  /^(\/\s*[A-Za-z]+|(?:per|an?)\s+[A-Za-z]+|hourly|daily|weekly|monthly|yearly|annually)(?![A-Za-z])/i;
const PAY_HOURLY_WORD_RE = /(?<![A-Za-z])(?:hr|hrs|hour|hours|hourly)(?![A-Za-z])/i;
/** Below this, an amount with no stated period is hourly (the plugin's historical fallback). */
const PAY_HOURLY_BELOW = 350;

interface PayBound {
  amount: number;
  currency: string | null;
  interval: CompensationInterval | null;
  plus: boolean;
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function parsePayBound(text: string): PayBound | null {
  let rest = text.trim();
  let currency: string | null = null;
  for (const [prefix, code] of LINKEDIN_CURRENCY_PREFIXES) {
    if (rest.startsWith(prefix)) {
      currency = code;
      rest = rest.slice(prefix.length).trimStart();
      break;
    }
  }
  if (!currency) {
    const iso = PAY_ISO_PREFIX_RE.exec(rest);
    if (iso) {
      currency = iso[1];
      rest = rest.slice(iso[0].length);
    }
  }

  const num = PAY_NUMBER_RE.exec(rest);
  if (!num) return null;
  const base = parseSalaryNumber(num[1], 'anglo');
  if (base === null) return null;
  const scale = num[2] ? (num[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
  rest = rest.slice(num[0].length).trim();

  let plus = false;
  if (rest.startsWith('+')) {
    plus = true;
    rest = rest.slice(1).trim();
  }
  const period = PAY_PERIOD_TOKEN_RE.exec(rest);
  const interval = period ? intervalFromPeriodToken(period[1]) : null;
  if (period) rest = rest.slice(period[0].length).trim();
  if (rest.startsWith('+')) plus = true;

  return { amount: roundToCents(base * scale), currency, interval, plus };
}

function fallbackInterval(text: string, amount: number): CompensationInterval {
  if (PAY_HOURLY_WORD_RE.test(text)) return CompensationInterval.HOURLY;
  return amount < PAY_HOURLY_BELOW ? CompensationInterval.HOURLY : CompensationInterval.YEARLY;
}

/**
 * Parse LinkedIn's pay display (`$53,000.00/yr - $65,000.00/yr`,
 * `CA$80,000.00/yr - CA$100,000.00/yr`, `SGD 6,000.00/mo`, `$120,000+`,
 * `up to $150,000/yr`, `$120K - $150K`). Never throws; `null` when the text
 * carries no usable amount.
 *
 * - Currency: the en-US display prefixes (longest first), else a leading
 *   ISO-4217 code, else USD. A second bound with no currency inherits the
 *   first; two different currencies give `null`.
 * - Numbers: always the anglo locale (we send `accept-language: en-US`), with
 *   a `K` / `M` suffix.
 * - Interval: a per-bound period token (`/yr`, `/hr`, `/mo`, `/wk`, `/day`);
 *   two different ones give `null`. With none, an hour word anywhere means
 *   hourly, else the magnitude decides (under 350 is hourly).
 * - One bound: a trailing `+` sets the minimum only, `up to` the maximum only,
 *   and a plain amount is a fixed pay (min = max).
 * - No magnitude limits: the period is explicit, so executive pay is kept.
 */
export function parseLinkedInPay(raw: string | null | undefined): CompensationDto | null {
  if (typeof raw !== 'string' || raw.length > PAY_MAX_LENGTH * 4) return null;
  let text = collapseWhitespace(raw);
  if (!text || text.length > PAY_MAX_LENGTH || !/\d/.test(text)) return null;

  const upTo = PAY_UP_TO_RE.exec(text);
  if (upTo) text = text.slice(upTo[0].length);

  const parts = text.split(PAY_RANGE_SPLIT_RE);
  if (parts.length > 2 || parts.some((part) => !part.trim())) return null;

  if (parts.length === 1) {
    const bound = parsePayBound(parts[0]);
    if (!bound || bound.amount <= 0) return null;
    const interval = bound.interval ?? fallbackInterval(text, bound.amount);
    const currency = bound.currency ?? 'USD';
    if (upTo) return new CompensationDto({ minAmount: null, maxAmount: bound.amount, currency, interval });
    if (bound.plus) return new CompensationDto({ minAmount: bound.amount, maxAmount: null, currency, interval });
    return new CompensationDto({ minAmount: bound.amount, maxAmount: bound.amount, currency, interval });
  }

  if (upTo) return null;
  const low = parsePayBound(parts[0]);
  const high = parsePayBound(parts[1]);
  if (!low || !high || high.amount <= 0) return null;
  const lowCurrency = low.currency ?? high.currency;
  const highCurrency = high.currency ?? low.currency;
  if (lowCurrency !== highCurrency) return null;
  if (low.interval && high.interval && low.interval !== high.interval) return null;
  if (low.amount > high.amount) return null;

  return new CompensationDto({
    minAmount: low.amount,
    maxAmount: high.amount,
    currency: lowCurrency ?? 'USD',
    interval: low.interval ?? high.interval ?? fallbackInterval(text, high.amount),
  });
}

/**
 * The card pay regex the plugin used before Spec 1701 (USD only, `hr`
 * substring for hourly). Kept for `EVER_JOBS_LINKEDIN_LEGACY=pay`.
 */
export function parseLegacyCardPay(salaryText: string | null | undefined): CompensationDto | null {
  if (typeof salaryText !== 'string') return null;
  const text = salaryText.trim();
  const match = text.match(/\$?([\d,]+(?:\.\d+)?)\s*[-/]\s*\$?([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  return new CompensationDto({
    minAmount: parseFloat(match[1].replace(/,/g, '')),
    maxAmount: parseFloat(match[2].replace(/,/g, '')),
    currency: 'USD',
    interval: text.toLowerCase().includes('hr') ? CompensationInterval.HOURLY : CompensationInterval.YEARLY,
  });
}

// ── Applicants (Spec 1701 §5.5) ──────────────────────────────────────────────

const APPLICANTS_OVER_RE = /over\s+([\d,]+)/i;
const APPLICANTS_FIRST_RE = /first\s+([\d,]+)/i;
const APPLICANTS_EXACT_RE = /([\d,]+)\s+applicants?\b/i;

function applicantCount(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ''));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * The applicant caption as a count and a bound: `154 applicants` is exact,
 * `Over 200 applicants` a minimum, `Be among the first 25 applicants` a
 * maximum. `null` when there is no number.
 */
export function parseApplicants(raw: string | null | undefined): ApplicantsInfo | null {
  const text = collapseWhitespace(raw);
  if (!text || text.length > 200) return null;
  const rules: Array<[RegExp, ApplicantsInfo['bound']]> = [
    [APPLICANTS_OVER_RE, 'min'],
    [APPLICANTS_FIRST_RE, 'max'],
    [APPLICANTS_EXACT_RE, 'exact'],
  ];
  for (const [re, bound] of rules) {
    const match = re.exec(text);
    if (!match) continue;
    const count = applicantCount(match[1]);
    return count === null ? null : { count, bound };
  }
  return null;
}

// ── Remote (Spec 1701 §5.6) ──────────────────────────────────────────────────

/** Phrases that contain "remote" but do not describe the workplace. */
const REMOTE_NEGATIVE_RE =
  /(?<![\p{L}\p{N}])(?:remote[\s-]+(?:sensing|controls?|support)|not[\s-]+remote|no[\s-]+remote|non[\s-]*remote)(?![\p{L}\p{N}])/giu;
/** Workplace words, whole words only. The spaced "home office" is left out: in US postings it means headquarters. */
const REMOTE_POSITIVE_RE =
  /(?<![\p{L}\p{N}])(?:remote|remoto|remota|t[ée]l[ée]travail|teletrabajo|home-?office|work(?:ing)?\s+from\s+home|wfh|telecommut(?:e|ing)|telework(?:ing)?)(?![\p{L}\p{N}])/iu;
const REMOTE_FIELD_MAX_LENGTH = 500;

/**
 * Whether any field (a title, a location label) states a remote workplace.
 * Whole-word and case-insensitive, with guards for "remote sensing",
 * "remote control", "remote support", "not remote", "no remote" and
 * "non-remote". Meant for short fields: LinkedIn calls it with the title and
 * location only, never the description.
 */
export function detectRemoteSignal(...fields: Array<string | null | undefined>): boolean {
  for (const field of fields) {
    if (typeof field !== 'string' || !field) continue;
    const text = field.slice(0, REMOTE_FIELD_MAX_LENGTH).replace(REMOTE_NEGATIVE_RE, ' ');
    if (REMOTE_POSITIVE_RE.test(text)) return true;
  }
  return false;
}

// ── Blocks (Spec 1701 §7) ────────────────────────────────────────────────────

/** axios' message for a non-2xx status: "Request failed with status code 999". */
const BLOCK_STATUS_MESSAGE_RE = new RegExp(`status code ${LINKEDIN_BLOCK_STATUS}\\b`);

interface ResponseLike {
  status?: unknown;
  message?: unknown;
  request?: { res?: { responseUrl?: unknown } };
  response?: ResponseLike;
}

function finalUrlOf(value: ResponseLike | undefined): string | null {
  const url = value?.request?.res?.responseUrl;
  return typeof url === 'string' ? url : null;
}

/**
 * Why a response or error is a LinkedIn block, else `null`: HTTP 999
 * (LinkedIn's refusal code, which `classifyScrapeError` alone maps to
 * `unknown`) or a final URL on a sign-in wall (`/authwall`, `/login`,
 * `/signup`, `/uas/login`, `/checkpoint`).
 */
export function linkedInBlockReason(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as ResponseLike;
  const status = typeof o.status === 'number' ? o.status : o.response?.status;
  if (status === LINKEDIN_BLOCK_STATUS) return `HTTP ${LINKEDIN_BLOCK_STATUS}`;
  if (typeof o.message === 'string' && BLOCK_STATUS_MESSAGE_RE.test(o.message)) {
    return `HTTP ${LINKEDIN_BLOCK_STATUS}`;
  }
  const finalUrl = finalUrlOf(o) ?? finalUrlOf(o.response);
  if (finalUrl && LINKEDIN_BLOCK_URL_RE.test(finalUrl)) return 'authwall';
  return null;
}

/** A `blocked` diagnostic for a LinkedIn block, else `null`. `where` names the request, e.g. `start=20`. */
export function linkedInBlockDiagnostics(value: unknown, where: string): ScrapeDiagnostics | null {
  const reason = linkedInBlockReason(value);
  return reason ? new ScrapeDiagnostics('blocked', `linkedin ${reason} at ${where}`) : null;
}

// ── Switches ─────────────────────────────────────────────────────────────────

const LEGACY_ALL_TOKENS = new Set(['all', 'true', '1', 'yes', 'on']);
const TRUTHY = new Set(['true', '1', 'yes', 'on']);

/**
 * Parse `EVER_JOBS_LINKEDIN_LEGACY`: a comma or space list of `pagination`,
 * `ids`, `pay`, `detail` and `remote`, or `all`. Unknown words are ignored;
 * unset keeps every Spec 1701 fix on.
 */
export function resolveLinkedInLegacy(env: NodeJS.ProcessEnv = process.env): LinkedInLegacyFlags {
  const tokens = new Set(
    (env[LINKEDIN_LEGACY_ENV] ?? '')
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean),
  );
  const all = [...tokens].some((token) => LEGACY_ALL_TOKENS.has(token));
  return {
    pagination: all || tokens.has('pagination'),
    ids: all || tokens.has('ids'),
    pay: all || tokens.has('pay'),
    detail: all || tokens.has('detail'),
    remote: all || tokens.has('remote'),
  };
}

/**
 * Whether to fetch company pages: `input.linkedinFetchCompanyDetails` when it
 * is a boolean, else `EVER_JOBS_LINKEDIN_FETCH_COMPANY_DETAILS`, else off.
 */
export function resolveFetchCompanyDetails(
  input: Pick<LinkedInScraperInput, 'linkedinFetchCompanyDetails'>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof input.linkedinFetchCompanyDetails === 'boolean') return input.linkedinFetchCompanyDetails;
  return TRUTHY.has((env[LINKEDIN_FETCH_COMPANY_DETAILS_ENV] ?? '').trim().toLowerCase());
}
