import * as cheerio from 'cheerio';
import {
  CompensationDto,
  CompensationInterval,
  Country,
  DatePostedBasis,
  DatePostedPrecision,
  DescriptionFormat,
  JobPostDto,
  JobType,
  LocationDto,
  ScraperInputDto,
  Site,
  looksLikeChallenge,
} from '@ever-jobs/models';
import {
  NO_POSTED_TIME,
  PostedTime,
  extractEmails,
  intervalFromPeriodToken,
  markdownConverter,
  parseLocationList,
  parseLocationText,
  parseSalaryNumber,
  plainConverter,
  postedFromRelativeLabel,
  postedFromTimestamp,
  postedTimeFields,
  toDateOnly,
} from '@ever-jobs/common';
import {
  INTERNSHALA_ALLOWED_PREFIXES,
  INTERNSHALA_BASE,
  INTERNSHALA_CITY_ALIASES,
  INTERNSHALA_DEFAULT_DESCRIPTION_DEPTH,
  INTERNSHALA_DEFAULT_RESULTS,
  INTERNSHALA_DESCRIPTION_BUDGET,
  INTERNSHALA_DETAIL_PREFIX,
  INTERNSHALA_DETAIL_SELECTOR,
  INTERNSHALA_DISALLOWED_PREFIXES,
  INTERNSHALA_ENV,
  INTERNSHALA_MAX_PAGES_CEILING,
  INTERNSHALA_MAX_PAGES_PER_STREAM,
  INTERNSHALA_MAX_TERM_LENGTH,
  INTERNSHALA_PLACEHOLDER_LOGO,
  INTERNSHALA_ROOT,
  INTERNSHALA_STREAM_ORDER,
} from './internshala.constants';
import {
  CardFilters,
  InternshalaDescriptionDepth,
  InternshalaIdScheme,
  InternshalaKind,
  InternshalaOptions,
  InternshalaStrategy,
  ListingQuery,
  ParsedCard,
  ParsedListingPage,
  PostedAge,
  SearchPlan,
  SkippedCard,
} from './internshala.types';

/*
 * Pure functions for the Internshala plugin (Spec 1706): URL building and the
 * robots.txt guard, listing/card parsing, pay and posted-date parsing, the
 * search plan and the card -> JobPostDto mapping. No I/O and no logging here;
 * the service owns requests, sleeps and diagnostics.
 */

const HOUR_MS = 3_600_000;

/** Characters that would make a URL robots-disallowed (or change its meaning). */
const UNSAFE_TERM_CHARS_RE = /[,?=&#/%\\]+/g;

/** A label that means "work from home" rather than a city. */
const WFH_LABEL_RE = /^work\s+from\s+home$/i;

/** A location input that names no city at all. */
const REMOTE_LOCATION_RE = /^(?:remote|work\s+from\s+home|wfh|anywhere)$/i;

/** Longest pay text we try to read (a pay span is a short label). */
const MAX_PAY_TEXT_LENGTH = 200;

/** Longest posted label we try to read. */
const MAX_POSTED_LABEL_LENGTH = 60;

/**
 * INR pay on a pay span: `₹ 2,00,000 - 2,60,000 /year`, `₹ 5,000 /month`,
 * `₹ 3,000 - 7,000 lump sum`. The period token keeps its connector so
 * `intervalFromPeriodToken` sees `/year` or `per annum`.
 */
const INR_PAY_RE =
  /(?:\u20b9|\bINR\b|\bRs\.?)\s*(?<min>\d[\d,]*(?:\.\d+)?)(?:\s*[-\u2013\u2014]\s*(?:\u20b9|\bINR\b|\bRs\.?)?\s*(?<max>\d[\d,]*(?:\.\d+)?))?(?:\s*(?<period>(?:\/\s*|per\s+)(?:year|yr|annum|month|mo|week|wk|day|hour|hr))\b|\s*(?<lump>lump\s*-?\s*sum))?/i;

/** Defensive: pay stated in lakhs per annum (`3 - 4.5 LPA`). Not seen on cards so far. */
const LPA_PAY_RE = /(?<min>\d+(?:\.\d+)?)\s*(?:[-\u2013\u2014]\s*(?<max>\d+(?:\.\d+)?)\s*)?LPA\b/i;

const POSTED_BUCKET_RE =
  /^(?:(?<fixed>just now|few (?:hours|minutes) ago|today|yesterday)|(?<amount>\d{1,4}|an?)\+? (?<unit>minutes?|mins?|hours?|hrs?|days?|weeks?|months?) ago)$/;

/** Collapse every whitespace run (incl. NBSP) to one space and trim. */
export function collapseWhitespace(value: string | null | undefined): string {
  return (value ?? '').replace(/[\s\u00a0\u2007\u202f]+/g, ' ').trim();
}

/** Lower-case, runs of anything but `[a-z0-9]` -> `-`, trimmed of `-`. */
export function slugify(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Legacy 32-bit string hash (the pre-Spec-1706 id scheme). */
export function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return hash;
}

/**
 * Search term safe to put in a listing path: robots-unsafe characters
 * (`, ? = & # / % \`) become spaces, whitespace collapses, and the result is
 * capped at {@link INTERNSHALA_MAX_TERM_LENGTH} characters.
 */
export function cleanSearchTerm(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const cleaned = collapseWhitespace(raw.slice(0, INTERNSHALA_MAX_TERM_LENGTH * 4).replace(UNSAFE_TERM_CHARS_RE, ' '));
  if (cleaned.length <= INTERNSHALA_MAX_TERM_LENGTH) return cleaned;
  const cut = cleaned.slice(0, INTERNSHALA_MAX_TERM_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/** `{kw}` of `/…/keywords-{kw}/`: the cleaned term, lower-cased and URL-encoded. */
export function keywordSegment(term: string): string {
  return encodeURIComponent(term.toLowerCase());
}

/**
 * Whether the profile-style slug of a term says the same thing as the term
 * (letters, digits, spaces and hyphens only). `c++` slugs to `c`, so a narrow
 * path would search for something else: such terms use the keyword strategy.
 */
export function isFaithfulSlugTerm(term: string): boolean {
  return /^[a-z0-9]+(?:[\s-]+[a-z0-9]+)*$/i.test(term);
}

/**
 * City filter from `input.location`: the first comma segment, mapped through
 * {@link INTERNSHALA_CITY_ALIASES} and slugified. `null` for a country-only or
 * remote-only value. `keys` are the slugs a card label may match (the input,
 * its alias target and every alias of that target).
 */
export function resolveCity(location: string | null | undefined): { slug: string; keys: string[] } | null {
  if (typeof location !== 'string') return null;
  const first = collapseWhitespace(location.split(',')[0] ?? '');
  if (!first || first.length > 80 || REMOTE_LOCATION_RE.test(first)) return null;
  for (const text of [location, first]) {
    const parsed = parseLocationText(text).location;
    if (parsed && !parsed.city && parsed.country) return null;
  }
  const lower = first.toLowerCase();
  const target = INTERNSHALA_CITY_ALIASES[lower] ?? lower;
  const slug = slugify(target);
  if (!slug) return null;
  const keys = new Set<string>([slugify(lower), slug]);
  for (const [alias, canonical] of Object.entries(INTERNSHALA_CITY_ALIASES)) {
    if (slugify(canonical) === slug) keys.add(slugify(alias));
  }
  keys.delete('');
  return { slug, keys: [...keys] };
}

/**
 * Listing path for one stream. `keyword` (or no city/remote narrowing) gives
 * `/…/keywords-{kw}/`, or the root when there is no term. `narrow` gives the
 * site's work-from-home or city form; remote wins over a city (a
 * work-from-home posting has no city).
 */
export function buildListingPath(kind: InternshalaKind, query: ListingQuery, strategy: InternshalaStrategy): string {
  const root = INTERNSHALA_ROOT[kind];
  const kw = query.term ? keywordSegment(query.term) : '';
  if (strategy === 'keyword' || (!query.city && !query.remote)) {
    return kw ? `${root}keywords-${kw}/` : root;
  }
  const slug = query.term ? slugify(query.term) : '';
  if (query.remote) {
    const noun = kind === 'job' ? 'jobs' : 'internships';
    return slug ? `${root}work-from-home-${slug}-${noun}/` : `${root}work-from-home-${noun}/`;
  }
  const noun = kind === 'job' ? 'jobs' : 'internship';
  return slug ? `${root}${slug}-${noun}-in-${query.city}/` : `${root}${noun}-in-${query.city}/`;
}

/** Absolute listing URL for a page (`page-N/` for N >= 2). Asserts it is robots-safe. */
export function buildListingUrl(
  kind: InternshalaKind,
  query: ListingQuery,
  strategy: InternshalaStrategy,
  page: number,
): string {
  const path = buildListingPath(kind, query, strategy);
  const url = `${INTERNSHALA_BASE}${path}${page >= 2 ? `page-${Math.floor(page)}/` : ''}`;
  assertRobotsSafe(url);
  return url;
}

/**
 * Whether robots.txt (`User-Agent: *`) lets us fetch this URL: https on the
 * board host, one of the listing/detail prefixes, none of the disallowed
 * prefixes, and no `?`, `,`, `#`, `%3F` or `%3D` anywhere in the path.
 */
export function isRobotsSafeUrl(url: string): boolean {
  if (typeof url !== 'string' || !url.startsWith(`${INTERNSHALA_BASE}/`)) return false;
  const path = url.slice(INTERNSHALA_BASE.length);
  if (/[?,#]|%3f|%3d/i.test(path)) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  // `..` or `.` segments would be normalised away: the raw path is not what we would fetch.
  if (pathname !== path) return false;
  const lower = path.toLowerCase();
  if (INTERNSHALA_DISALLOWED_PREFIXES.some((p) => lower.startsWith(p))) return false;
  return INTERNSHALA_ALLOWED_PREFIXES.some((p) => lower.startsWith(p));
}

/** Throws when a URL we built is not robots-safe (a programming error, never input-driven). */
export function assertRobotsSafe(url: string): void {
  if (!isRobotsSafeUrl(url)) {
    throw new Error(`internshala: refusing a robots-disallowed URL: ${url}`);
  }
}

/**
 * Canonical/listing path normalised for comparison: path only, percent-decoded,
 * lower-case, `page-N/` removed, trailing `/` ensured. `null` for no value.
 */
export function normaliseListingPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let path: string;
  try {
    path = new URL(value.trim(), `${INTERNSHALA_BASE}/`).pathname;
  } catch {
    return null;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the encoded form
  }
  path = path.toLowerCase().replace(/\/{2,}/g, '/').replace(/page-\d+\/?$/, '');
  return path.endsWith('/') ? path : `${path}/`;
}

/** `/jobs/` or `/internships/`: the unfiltered feed. */
export function isRootListingPath(path: string | null): boolean {
  return path === INTERNSHALA_ROOT.job || path === INTERNSHALA_ROOT.internship;
}

/**
 * Canonical guard verdict for a fetched listing page.
 * `dropped` = the site served its unfiltered root for a filtered request.
 */
export function classifyCanonical(
  requestedPath: string,
  servedPath: string | null,
): 'match' | 'dropped' | 'mismatch' | 'absent' {
  const served = normaliseListingPath(servedPath);
  if (served === null) return 'absent';
  const requested = normaliseListingPath(requestedPath);
  if (served === requested) return 'match';
  if (isRootListingPath(served) && !isRootListingPath(requested)) return 'dropped';
  return 'mismatch';
}

/**
 * Age bucket of a relative posted label, or `null` when it is not one.
 *
 * | label | lowerH | widthH |
 * | just now, few hours ago, today, N minute(s) ago | 0 | 24 |
 * | N hour(s) ago | N | 24 |
 * | yesterday | 24 | 24 |
 * | N day(s) ago | 24·N | 24 |
 * | N week(s) ago | 168·N | 168 |
 * | N month(s) ago | 720·N | 720 |
 */
export function parsePostedAge(label: string | null | undefined): PostedAge | null {
  if (typeof label !== 'string' || label.length > MAX_POSTED_LABEL_LENGTH * 4) return null;
  const text = collapseWhitespace(label).toLowerCase();
  if (!text || text.length > MAX_POSTED_LABEL_LENGTH) return null;
  const match = POSTED_BUCKET_RE.exec(text);
  if (!match?.groups) return null;
  const { fixed, amount, unit } = match.groups;
  if (fixed) {
    return fixed === 'yesterday' ? { lowerH: 24, widthH: 24 } : { lowerH: 0, widthH: 24 };
  }
  const n = amount === 'a' || amount === 'an' ? 1 : Number(amount);
  if (!Number.isFinite(n)) return null;
  if (unit.startsWith('mi')) return { lowerH: 0, widthH: 24 };
  if (unit.startsWith('h')) return { lowerH: n, widthH: 24 };
  if (unit.startsWith('d')) return { lowerH: 24 * n, widthH: 24 };
  if (unit.startsWith('w')) return { lowerH: 168 * n, widthH: 168 };
  return { lowerH: 720 * n, widthH: 720 };
}

/** Trailing 10-digit epoch (seconds) of a detail slug, or `null`. Undocumented: only a guarded hint. */
export function slugEpochSeconds(path: string | null | undefined): number | null {
  if (typeof path !== 'string') return null;
  const match = /(\d{10})\/?$/.exec(path);
  return match ? Number(match[1]) : null;
}

function precisionForWidth(widthH: number): DatePostedPrecision {
  if (widthH >= 720) return DatePostedPrecision.MONTH;
  if (widthH >= 168) return DatePostedPrecision.WEEK;
  return DatePostedPrecision.DAY;
}

/**
 * Posting time of a card.
 *
 * 1. No usable label -> nothing.
 * 2. With `useSlugTimestamp`, a slug epoch whose age falls inside
 *    `[lowerH − 24, lowerH + widthH + 168]` hours wins (exact instant).
 * 3. A numeric hours/minutes label -> the shared relative-label helper (an instant).
 * 4. Otherwise `datePosted = now − lowerH` hours, at the bucket's precision.
 */
export function resolvePostedTime(
  label: string | null | undefined,
  path: string | null | undefined,
  nowMs: number,
  useSlugTimestamp = true,
): PostedTime {
  const age = parsePostedAge(label);
  if (!age || !Number.isFinite(nowMs)) return { ...NO_POSTED_TIME };

  if (useSlugTimestamp) {
    const epoch = slugEpochSeconds(path);
    if (epoch !== null) {
      const ageH = (nowMs - epoch * 1000) / HOUR_MS;
      if (ageH >= age.lowerH - 24 && ageH <= age.lowerH + age.widthH + 168) {
        const exact = postedFromTimestamp(epoch, nowMs);
        if (exact.datePosted) return exact;
      }
    }
  }

  const text = collapseWhitespace(label).toLowerCase();
  if (/^(?:\d{1,4}|an?) (?:hours?|hrs?|minutes?|mins?) ago$/.test(text)) {
    const relative = postedFromRelativeLabel(text, nowMs);
    if (relative.datePosted) return relative;
  }

  const datePosted = toDateOnly(nowMs - age.lowerH * HOUR_MS);
  if (!datePosted) return { ...NO_POSTED_TIME };
  return {
    datePosted,
    datePostedAt: null,
    datePostedPrecision: precisionForWidth(age.widthH),
    datePostedBasis: DatePostedBasis.RELATIVE,
  };
}

/**
 * INR pay from a pay span's text. `null` for "Unpaid", "Competitive salary",
 * or anything without an amount. No period: a job is yearly, an internship
 * monthly. A lump sum is a one-off amount: `interval: null`.
 */
export function parseInrPay(text: string | null | undefined, kind: InternshalaKind): CompensationDto | null {
  if (typeof text !== 'string') return null;
  const s = collapseWhitespace(text);
  if (!s || s.length > MAX_PAY_TEXT_LENGTH || /\bunpaid\b/i.test(s)) return null;

  const lpa = LPA_PAY_RE.exec(s);
  if (lpa?.groups) {
    const min = Number(lpa.groups.min);
    const max = lpa.groups.max !== undefined ? Number(lpa.groups.max) : min;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || min > max) return null;
    return new CompensationDto({
      interval: CompensationInterval.YEARLY,
      minAmount: Math.round(min * 100_000),
      maxAmount: Math.round(max * 100_000),
      currency: 'INR',
    });
  }

  const match = INR_PAY_RE.exec(s);
  if (!match?.groups) return null;
  const min = parseSalaryNumber(match.groups.min, 'anglo');
  const max = match.groups.max !== undefined ? parseSalaryNumber(match.groups.max, 'anglo') : min;
  if (min === null || max === null || min <= 0 || min > max) return null;

  let interval: CompensationInterval | null;
  if (match.groups.lump) {
    interval = null;
  } else if (match.groups.period) {
    interval = intervalFromPeriodToken(match.groups.period);
    if (interval === null) return null;
  } else {
    interval = kind === 'job' ? CompensationInterval.YEARLY : CompensationInterval.MONTHLY;
  }
  return new CompensationDto({ interval, minAmount: min, maxAmount: max, currency: 'INR' });
}

/**
 * A card's detail path from an `href` / `data-href`: board host only, query
 * and fragment stripped, and it must be a `/job/detail/` or
 * `/internship/detail/` path. `null` otherwise.
 */
export function toDetailPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
    let parsed: URL;
    try {
      parsed = new URL(value, `${INTERNSHALA_BASE}/`);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (host !== 'internshala.com' && host !== 'www.internshala.com') return null;
    value = parsed.pathname;
  }
  value = value.split(/[?#]/)[0];
  if (!value.startsWith('/')) value = `/${value}`;
  const lower = value.toLowerCase();
  return lower.startsWith(INTERNSHALA_DETAIL_PREFIX.job) || lower.startsWith(INTERNSHALA_DETAIL_PREFIX.internship)
    ? value
    : null;
}

function absoluteLogo(src: string | null | undefined): string | null {
  const value = (src ?? '').trim();
  if (!value || value.includes(INTERNSHALA_PLACEHOLDER_LOGO)) return null;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `${INTERNSHALA_BASE}${value}`;
  return /^https?:\/\//i.test(value) ? value : null;
}

/** The card's plain-text snippet: lines trimmed, blank-line runs collapsed. */
export function normaliseSnippet(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).map((line) => line.replace(/[ \t\u00a0\u2007\u202f]+/g, ' ').trim());
  const out: string[] = [];
  for (const line of lines) {
    if (!line && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.length ? out.join('\n') : null;
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function rowSpanText($card: cheerio.Cheerio<any>, iconClass: string): string | null {
  const $icon = $card.find(`i.${iconClass}`).first();
  if (!$icon.length) return null;
  const text = collapseWhitespace($icon.parent().find('span').first().text());
  return text || null;
}

function kindFromPath(path: string): InternshalaKind | null {
  const lower = path.toLowerCase();
  if (lower.startsWith(INTERNSHALA_DETAIL_PREFIX.job)) return 'job';
  if (lower.startsWith(INTERNSHALA_DETAIL_PREFIX.internship)) return 'internship';
  return null;
}

/** Parse one card container; a string is the reason it was skipped. */
function parseCard($: cheerio.CheerioAPI, $card: cheerio.Cheerio<any>, streamKind: InternshalaKind): ParsedCard | string {
  const title =
    collapseWhitespace($card.find('a.job-title-href').first().text()) ||
    collapseWhitespace($card.find('h2.job-internship-name').first().text());
  if (!title) return 'no title';

  const path = toDetailPath($card.find('a.job-title-href').first().attr('href')) ?? toDetailPath($card.attr('data-href'));
  if (!path) return `no detail link for "${title}"`;

  const typeAttr = collapseWhitespace($card.attr('employment_type')).toLowerCase();
  const kind: InternshalaKind =
    typeAttr === 'job' || typeAttr === 'internship' ? typeAttr : (kindFromPath(path) ?? streamKind);

  // cheerio lower-cases attribute names: `internshipId` is read as `internshipid`.
  const rawId = collapseWhitespace($card.attr('internshipid'));
  const internshipId = /^\d+$/.test(rawId)
    ? rawId
    : (/^individual_internship_(\d+)$/.exec(collapseWhitespace($card.attr('id')))?.[1] ?? null);

  // `.company-name` (the inner <p>) holds just the name; the wrapping
  // `.company_name` div also holds an "Actively hiring" badge, so it is only a fallback.
  let $company = $card.find('.company-name').first();
  if (!$company.length) $company = $card.find('.company_name, .link_display_like_text').first();
  const $companyText = $company.clone();
  $companyText.find('.actively-hiring-badge').remove();
  const companyName = collapseWhitespace($companyText.text()) || collapseWhitespace($card.find('p.company-name a').text()) || null;

  const companyLogo = absoluteLogo($card.find('.internship_logo img').first().attr('src'));

  // Locations: jobs carry one <a> per city, internships one <a> with a comma list.
  const $locations = $card.find('.locations').first();
  let rawLabels = $locations
    .find('a')
    .map((_, a) => $(a).text())
    .get() as string[];
  if (!rawLabels.length && $locations.length) {
    const $text = $locations.clone();
    $text.find('i, .compensation-breakup-icon').remove();
    rawLabels = [$text.text()];
  }
  const labels = rawLabels
    .flatMap((label) => label.split(','))
    .map((label) => collapseWhitespace(label.replace(/\(\s*hybrid\s*\)/gi, ' ')))
    .filter(Boolean);
  const remote = $locations.find('i.ic-16-home').length > 0 || labels.some((label) => WFH_LABEL_RE.test(label));
  const locationLabels = uniqueCaseInsensitive(labels.filter((label) => !WFH_LABEL_RE.test(label)));
  const $ownText = $locations.clone();
  $ownText.find('a').remove();
  const hybrid = /\(\s*hybrid\s*\)/i.test($ownText.text()) || rawLabels.some((label) => /\(\s*hybrid\s*\)/i.test(label));

  // Pay: scoped to the pay row only; the post-internship offer label also carries ₹.
  const $payRow = $card.find('i.ic-16-money').first().parent();
  let $pay = $payRow.find('span.stipend').first();
  if (!$pay.length) $pay = $payRow.find('span.mobile').first();
  if (!$pay.length) $pay = $payRow.find('span.desktop').first();
  if (!$pay.length) $pay = $payRow.find('span').first();
  const payText = collapseWhitespace($pay.text()) || null;

  const $posted = $card.find('i.ic-16-reschedule').first();
  const postedLabel =
    collapseWhitespace($posted.next('span').text()) || collapseWhitespace($posted.parent().find('span').first().text()) || null;

  const statusLabels = $card
    .find('.gray-labels .status-li span')
    .map((_, el) => collapseWhitespace($(el).text()))
    .get()
    .filter(Boolean) as string[];

  const skills = uniqueCaseInsensitive(
    $card
      .find('.job_skills .job_skill')
      .map((_, el) => collapseWhitespace($(el).text()))
      .get()
      .filter(Boolean) as string[],
  );

  return {
    internshipId,
    kind,
    title,
    path,
    jobUrl: `${INTERNSHALA_BASE}${path}`,
    companyName,
    companyLogo,
    locationLabels,
    remote,
    hybrid,
    payText,
    compensation: parseInrPay(payText, kind),
    duration: rowSpanText($card, 'ic-16-calendar'),
    experience: rowSpanText($card, 'ic-16-briefcase'),
    snippet: normaliseSnippet($card.find('.about_job .text').first().text()),
    skills,
    postedLabel,
    postedAge: parsePostedAge(postedLabel),
    statusLabels,
    ppoText: collapseWhitespace($card.find('.gray-labels .ppo_status').first().text()) || null,
    // Same selectors the pre-Spec-1706 parser read, so the deadline is kept
    // whenever a card still shows it.
    applyBy: collapseWhitespace($card.find('.apply_by .item_body, .ic-16-clock + span').first().text()) || null,
    partTime: statusLabels.some((label) => /^part[\s-]*time$/i.test(label)),
    international: statusLabels.some((label) => /^international$/i.test(label)),
  };
}

/**
 * Parse a listing page. Only `div.individual_internship` containers count as
 * cards (their `.internship_meta` child is part of the card, not another one);
 * the pre-Spec-1706 container classes are a fallback when none is present.
 */
export function parseListingPage(html: string, streamKind: InternshalaKind): ParsedListingPage {
  const $ = cheerio.load(typeof html === 'string' ? html : '');
  let $containers = $('div.individual_internship');
  if (!$containers.length) {
    const legacy = '.individual_job, .job-listing-card';
    $containers = $(legacy).filter((_, el) => $(el).parents(legacy).length === 0);
  }

  const cards: ParsedCard[] = [];
  const skipped: SkippedCard[] = [];
  $containers.each((index, el) => {
    try {
      const result = parseCard($, $(el), streamKind);
      if (typeof result === 'string') skipped.push({ index, reason: result });
      else cards.push(result);
    } catch (err) {
      skipped.push({ index, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  const lastValue = collapseWhitespace($('input#isLastPage').first().attr('value'));
  const isLastPage = lastValue === '1' ? true : lastValue === '0' ? false : null;

  const pages = $('a.pagination_block[data-page]')
    .map((_, el) => Number(collapseWhitespace($(el).attr('data-page'))))
    .get()
    .filter((n: number) => Number.isInteger(n) && n > 0) as number[];

  return {
    cards,
    cardCount: $containers.length,
    skipped,
    isLastPage,
    maxPage: pages.length ? Math.max(...pages) : null,
    canonicalPath: normaliseListingPath($('link[rel="canonical"]').first().attr('href')),
    looksBlocked: $containers.length === 0 && looksLikeChallenge(typeof html === 'string' ? html : ''),
  };
}

/** Detail-page body as Markdown (default) or plain text; `null` when absent or empty. */
export function parseDetailDescription(html: string, format?: DescriptionFormat): string | null {
  const $ = cheerio.load(typeof html === 'string' ? html : '');
  const $body = $(INTERNSHALA_DETAIL_SELECTOR).first();
  if (!$body.length) return null;
  const inner = $body.html() ?? '';
  const text = format === DescriptionFormat.PLAIN ? plainConverter(inner) : markdownConverter(inner);
  const trimmed = text?.trim();
  return trimmed ? trimmed : null;
}

/** Whether a parsed card passes the search's client-side filters. */
export function cardMatchesFilters(card: ParsedCard, filters: CardFilters): boolean {
  if (filters.remote && !card.remote) return false;
  if (filters.cityKeys && !card.locationLabels.some((label) => filters.cityKeys!.includes(slugify(label)))) {
    return false;
  }
  if (filters.partTime === 'only' && !card.partTime) return false;
  if (filters.partTime === 'exclude' && card.partTime) return false;
  if (filters.maxAgeHours !== null && card.postedAge && card.postedAge.lowerH > filters.maxAgeHours) return false;
  return true;
}

/** Location fields of a card: per-site `locations[]`, the merged `location`, and the remote flags. */
export function buildCardLocation(card: ParsedCard): {
  location: LocationDto;
  locations: LocationDto[];
  isRemote: boolean;
  workFromHomeType: string | null;
} {
  const country = card.international ? null : Country.INDIA;
  const workFromHomeType = card.remote ? 'Remote' : card.hybrid ? 'Hybrid' : null;
  const stamp = (loc: LocationDto): LocationDto => new LocationDto({ ...loc, country: loc.country ?? country });
  if (!card.locationLabels.length) {
    return { location: new LocationDto({ country }), locations: [], isRemote: card.remote, workFromHomeType };
  }
  const parsed = parseLocationList(card.locationLabels);
  return {
    location: parsed.location ? stamp(parsed.location) : new LocationDto({ country }),
    locations: parsed.locations.map(stamp),
    isRemote: card.remote,
    workFromHomeType,
  };
}

/** `jobType` of a card: internship (+ part-time) or full-/part-time job. */
export function cardJobTypes(card: ParsedCard): JobType[] {
  if (card.kind === 'internship') {
    return card.partTime ? [JobType.INTERNSHIP, JobType.PART_TIME] : [JobType.INTERNSHIP];
  }
  return [card.partTime ? JobType.PART_TIME : JobType.FULL_TIME];
}

/** `is-<internshipId>` (default) or the pre-Spec-1706 `is-<hash(jobUrl)>`. */
export function cardId(card: ParsedCard, scheme: InternshalaIdScheme = 'posting'): string {
  if (scheme === 'posting' && card.internshipId) return `is-${card.internshipId}`;
  return `is-${Math.abs(hashCode(card.jobUrl))}`;
}

/**
 * Description: the body (detail page or card snippet), a blank line, then the
 * extras line `Stipend|Salary: … | Duration: … | Experience: … | <offer>`.
 */
export function composeDescription(body: string | null | undefined, card: ParsedCard): string | null {
  const extras: string[] = [];
  if (card.payText) extras.push(`${card.kind === 'internship' ? 'Stipend' : 'Salary'}: ${card.payText}`);
  if (card.duration) extras.push(`Duration: ${card.duration}`);
  if (card.experience) extras.push(`Experience: ${card.experience}`);
  if (card.ppoText) extras.push(card.ppoText);
  if (card.applyBy) extras.push(`Apply by: ${card.applyBy}`);
  const line = extras.join(' | ');
  const text = body?.trim() ? body.trim() : '';
  if (text && line) return `${text}\n\n${line}`;
  return text || line || null;
}

export interface CardToJobPostContext {
  nowMs: number;
  idScheme?: InternshalaIdScheme;
  slugTimestamp?: boolean;
  /** Final description; defaults to the snippet plus the extras line. */
  description?: string | null;
}

/** Map a parsed card to the shared DTO. */
export function cardToJobPost(card: ParsedCard, ctx: CardToJobPostContext): JobPostDto {
  const where = buildCardLocation(card);
  const description = ctx.description !== undefined ? ctx.description : composeDescription(card.snippet, card);
  const posted = resolvePostedTime(card.postedLabel, card.path, ctx.nowMs, ctx.slugTimestamp !== false);
  return new JobPostDto({
    id: cardId(card, ctx.idScheme ?? 'posting'),
    title: card.title,
    companyName: card.companyName || undefined,
    jobUrl: card.jobUrl,
    location: where.location,
    locations: where.locations,
    description,
    isRemote: where.isRemote,
    workFromHomeType: where.workFromHomeType,
    emails: extractEmails(description) ?? extractEmails(card.snippet),
    companyLogo: card.companyLogo,
    listingType: card.kind,
    jobType: cardJobTypes(card),
    compensation: card.compensation,
    ...postedTimeFields(posted),
    skills: card.skills.length ? [...card.skills] : null,
    experienceRange: card.experience,
    site: Site.INTERNSHALA,
  });
}

/** Round-robin merge: a[0], b[0], a[1], b[1], … then the remainder. */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      if (i < list.length) out.push(list[i]);
    }
  }
  return out;
}

const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

/** Environment switches (see {@link INTERNSHALA_ENV}); unknown values fall back to the defaults. */
export function resolveInternshalaOptions(env: Record<string, string | undefined> = {}): InternshalaOptions {
  const streamsRaw = (env[INTERNSHALA_ENV.defaultStreams] ?? '').trim().toLowerCase();
  const defaultStreams =
    streamsRaw === 'job' || streamsRaw === 'jobs'
      ? 'job'
      : streamsRaw === 'internship' || streamsRaw === 'internships'
        ? 'internship'
        : 'both';

  const idRaw = (env[INTERNSHALA_ENV.idScheme] ?? '').trim().toLowerCase();
  const idScheme: InternshalaIdScheme = idRaw === 'url-hash' || idRaw === 'legacy' ? 'url-hash' : 'posting';

  const pagesRaw = (env[INTERNSHALA_ENV.maxPages] ?? '').trim();
  const pages = /^\d{1,3}$/.test(pagesRaw) ? Number(pagesRaw) : Number.NaN;
  const maxPages = pages >= 1 && pages <= INTERNSHALA_MAX_PAGES_CEILING ? pages : INTERNSHALA_MAX_PAGES_PER_STREAM;

  const slugRaw = (env[INTERNSHALA_ENV.slugTimestamp] ?? '').trim().toLowerCase();
  return { defaultStreams, idScheme, maxPages, slugTimestamp: !OFF_VALUES.has(slugRaw) };
}

/** Description depth key; unknown or unset -> {@link INTERNSHALA_DEFAULT_DESCRIPTION_DEPTH}. */
export function resolveDescriptionDepth(raw: string | null | undefined): InternshalaDescriptionDepth {
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(INTERNSHALA_DESCRIPTION_BUDGET, raw)
    ? (raw as InternshalaDescriptionDepth)
    : INTERNSHALA_DEFAULT_DESCRIPTION_DEPTH;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Everything decided before the first request: streams, query, strategy,
 * client filters, paging and the detail budget.
 *
 * `jobType`: unset -> the default streams (both); `internship` -> internships;
 * `fulltime` -> jobs without "Part time"; `parttime` -> both streams, "Part
 * time" only; anything else has no equivalent here (`unsupportedJobType`).
 * `isRemote` narrows to work-from-home and ignores the city (such postings
 * have none); a country-only `location` is no filter.
 */
export function planSearch(input: Partial<ScraperInputDto>, options: InternshalaOptions): SearchPlan {
  const resultsWanted = nonNegativeInt(input.resultsWanted, INTERNSHALA_DEFAULT_RESULTS);
  const offset = nonNegativeInt(input.offset, 0);
  const depth = resolveDescriptionDepth(input.descriptionDepth);

  const jobType = typeof input.jobType === 'string' ? input.jobType.toLowerCase() : '';
  let kinds: InternshalaKind[] = [];
  let partTime: CardFilters['partTime'] = null;
  let unsupportedJobType: string | null = null;
  if (!jobType) {
    kinds = options.defaultStreams === 'both' ? [...INTERNSHALA_STREAM_ORDER] : [options.defaultStreams];
  } else if (jobType === JobType.INTERNSHIP) {
    kinds = ['internship'];
  } else if (jobType === JobType.FULL_TIME) {
    kinds = ['job'];
    partTime = 'exclude';
  } else if (jobType === JobType.PART_TIME) {
    kinds = [...INTERNSHALA_STREAM_ORDER];
    partTime = 'only';
  } else {
    unsupportedJobType = String(input.jobType);
  }

  const term = cleanSearchTerm(input.searchTerm);
  const remote = input.isRemote === true;
  const city = remote ? null : resolveCity(input.location);
  const narrow = (remote || city !== null) && (!term || isFaithfulSlugTerm(term));
  const hoursOld = typeof input.hoursOld === 'number' && Number.isFinite(input.hoursOld) && input.hoursOld > 0
    ? input.hoursOld
    : null;

  return {
    kinds,
    query: { term, city: city?.slug ?? null, remote },
    strategy: narrow ? 'narrow' : 'keyword',
    filters: { remote, cityKeys: city?.keys ?? null, partTime, maxAgeHours: hoursOld },
    resultsWanted,
    offset,
    need: offset + resultsWanted,
    depth,
    detailBudget: INTERNSHALA_DESCRIPTION_BUDGET[depth],
    unsupportedJobType,
  };
}
