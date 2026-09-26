import {
  CompensationDto,
  CompensationInterval,
  getCompensationInterval,
  ScrapeDiagnostics,
} from '@ever-jobs/models';
import {
  canonicalCountryName,
  decodeHtmlEntities,
  extractLdJsonBlocks,
  isoAlpha3FromAlpha2,
  jobPostingLdToCompensation,
  parseJobPostingLd,
  parseLocationList,
  regionNameFromCode,
  stripHtmlTags,
} from '@ever-jobs/common';
import {
  JOBSBYLEVEL_BASE_URL,
  JOBSBYLEVEL_COMPANY_PATH,
  JOBSBYLEVEL_DETAIL_BUDGET,
  JOBSBYLEVEL_DISALLOWED_PATH_PREFIXES,
  JOBSBYLEVEL_HOST,
  JOBSBYLEVEL_JOB_PATH,
  JOBSBYLEVEL_LEVEL_BANDS,
  JOBSBYLEVEL_MAX_ARG_LENGTH,
  JOBSBYLEVEL_YEARLY_SALARY_FLOOR,
} from './jobsbylevel.constants';
import {
  JobsByLevelCompanyObject,
  JobsByLevelDetail,
  JobsByLevelFeedItem,
  JobsByLevelItem,
  JobsByLevelRpcResponse,
  JobsByLevelSearchEnvelope,
} from './jobsbylevel.types';

/**
 * Pure helpers for the Level plugin (Spec 1693). Nothing here performs I/O,
 * reads the clock or throws on bad data, except the response parsers, which
 * throw {@link JobsByLevelResponseError} carrying a ready diagnostic.
 */

/** A response we could read but must not use; carries the diagnostic to report. */
export class JobsByLevelResponseError extends Error {
  constructor(readonly diagnostics: ScrapeDiagnostics) {
    super(diagnostics.detail ?? diagnostics.reason);
    this.name = 'JobsByLevelResponseError';
  }
}

function responseError(reason: ScrapeDiagnostics['reason'], detail: string): JobsByLevelResponseError {
  return new JobsByLevelResponseError(new ScrapeDiagnostics(reason, detail.slice(0, 300)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

/** A finite number from a number or a plain numeric string; null otherwise. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** `true`, `1`, `'1'`, `'true'`, `'yes'` (any case) are true; everything else is false. */
export function isTruthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

// ── AI level ────────────────────────────────────────────────────────────────

/**
 * Published band for a 0-100 score: 80+ is 4, 60+ is 3, 40+ is 2, 0+ is 1.
 * Non-numeric, negative or above-100 values give null.
 */
export function aiLevelFromScore(score: unknown): number | null {
  const n = toFiniteNumber(score);
  if (n === null || n < 0 || n > 100) return null;
  for (const [lower, level] of JOBSBYLEVEL_LEVEL_BANDS) {
    if (n >= lower) return level;
  }
  return null;
}

/** The item's own 1-4 `ai_level` when valid, else the band of `ai_score`. */
export function resolveAiLevel(item: Pick<JobsByLevelItem, 'ai_level' | 'ai_score'>): number | null {
  const level = toFiniteNumber(item.ai_level);
  if (level !== null && Number.isInteger(level) && level >= 1 && level <= 4) return level;
  return aiLevelFromScore(item.ai_score);
}

/** Visible badge text on a listing page: "AI Level 1 of 4: Little AI". */
const AI_LEVEL_TEXT_RE = /\bAI Level\s*([1-4])\s*of\s*4\b/i;

/** Read the AI level from a listing page's visible text (it is not in the JSON-LD). */
export function aiLevelFromPageHtml(html: string): number | null {
  if (!html) return null;
  const text = stripHtmlTags(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ''),
  ).replace(/\s+/g, ' ');
  const match = AI_LEVEL_TEXT_RE.exec(text);
  return match ? Number(match[1]) : null;
}

// ── Country and location ────────────────────────────────────────────────────

/** ISO 3166-1 alpha-2, upper-cased; the operator's `UK` becomes `GB`. Invalid gives null. */
export function normaliseCountryCode(raw: unknown): string | null {
  const text = trimmed(raw);
  if (!text) return null;
  let code = text.toUpperCase();
  if (code === 'UK') code = 'GB';
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return isoAlpha3FromAlpha2(code) ? code : null;
}

/** "Remote (world)" and friends: remote with no geography. */
const WORLDWIDE_PAREN_RE = /\s*\((?:world|worldwide|global|anywhere|international)\)\s*/gi;
/** "US-WA-Bellevue": country, state and city codes joined by hyphens. */
const CODED_LOCATION_RE = /^([A-Za-z]{2})-([A-Za-z]{2})-([^-].*)$/;
/** "San Francisco (United States)". */
const TRAILING_PAREN_RE = /^([^()]+?)\s*\(([^()]+)\)$/;
/** "Hybrid Paris": a work-mode word glued to a place with no separator. */
const LEADING_MODE_RE = /^(hybrid|remote|on-?site|in-office)\s+(?![-–—(,/])(\S.*)$/i;
/** Several sites in one label; the single posting country cannot be attached to each. */
const MULTI_SITE_RE = /\s\/\s|;|\|/;

/**
 * Rewrite the label shapes Level uses that the shared parser misreads, so it
 * sees "City, ST, US" instead of one opaque city token.
 */
export function normaliseLocationText(raw: string | null | undefined): string {
  let text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  text = text.replace(WORLDWIDE_PAREN_RE, ' ').trim();

  const coded = CODED_LOCATION_RE.exec(text);
  if (coded) {
    text = `${coded[3].trim()}, ${coded[2].toUpperCase()}, ${coded[1].toUpperCase()}`;
  }

  const paren = TRAILING_PAREN_RE.exec(text);
  if (paren && canonicalCountryName(paren[2].trim())) {
    text = `${paren[1].trim()}, ${paren[2].trim()}`;
  }

  const mode = LEADING_MODE_RE.exec(text);
  if (mode) text = `${mode[1]} - ${mode[2]}`;

  return text;
}

/**
 * The label handed to the location parser: the listing's own text, with the
 * posting country appended only when the text does not already name a
 * country, is not the country itself and does not list several sites. Avoids
 * "United Kingdom, United Kingdom" and keeps a bare "CA" from being read
 * without its country.
 */
export function buildLocationLabel(
  raw: string | null | undefined,
  countryCode: string | null,
): string | null {
  const text = normaliseLocationText(raw);
  const countryName = countryCode ? regionNameFromCode(countryCode) : null;
  if (!countryName) return text || null;
  if (!text) return countryName;
  if (text.toLowerCase() === countryName.toLowerCase()) return countryName;
  if (MULTI_SITE_RE.test(text)) return text;
  if (parseLocationList([text]).location?.country) return text;
  return `${text}, ${countryName}`;
}

export interface JobsByLevelLocationMatcher {
  /** Canonical country name when the query names a country (then no `city` is sent). */
  country: string | null;
  /** Value for the server-side `city` argument, or null. */
  serverCity: string | null;
  matches(label: string | null, countryCode: string | null): boolean;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Case-insensitive location filter: a substring of the label (a whole word
 * for queries of three characters or fewer, so "ca" does not match
 * "Cambridge"), or the same country as the posting's ISO code.
 */
export function buildLocationMatcher(query: string | null | undefined): JobsByLevelLocationMatcher | null {
  const q = trimmed(query);
  if (!q) return null;
  const lower = q.toLowerCase();
  const country = canonicalCountryName(q);
  const short = lower.length <= 3;
  return {
    country,
    serverCity: country ? null : q.slice(0, JOBSBYLEVEL_MAX_ARG_LENGTH),
    matches(label, countryCode) {
      if (country && countryCode) {
        const posting = canonicalCountryName(countryCode);
        if (posting && posting.toLowerCase() === country.toLowerCase()) return true;
      }
      const hay = (label ?? '').toLowerCase();
      if (!hay) return false;
      return short ? words(hay).includes(lower) : hay.includes(lower);
    },
  };
}

// ── Salary, labels, skills ──────────────────────────────────────────────────

function positiveAmount(value: unknown): number | null {
  const n = toFiniteNumber(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * Structured pay range. A stated period wins; with none, bounds of 10 000 or
 * more read as yearly and smaller ones keep no interval (never guessed).
 * Zero, negative or absent bounds give null.
 */
export function buildCompensation(
  item: Pick<JobsByLevelItem, 'salary_min' | 'salary_max' | 'salary_currency' | 'salary_frequency'>,
): CompensationDto | null {
  let min = positiveAmount(item.salary_min);
  let max = positiveAmount(item.salary_max);
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min > max) [min, max] = [max, min];

  const period = trimmed(item.salary_frequency);
  const stated = period ? getCompensationInterval(period) : null;
  const interval =
    stated ??
    (Math.max(min ?? 0, max ?? 0) >= JOBSBYLEVEL_YEARLY_SALARY_FLOOR
      ? CompensationInterval.YEARLY
      : null);
  const currency = trimmed(item.salary_currency);

  return new CompensationDto({
    interval: interval ?? undefined,
    minAmount: min,
    maxAmount: max,
    currency: currency && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : undefined,
  });
}

const EMPTY_LABELS = new Set(['', 'other', 'unknown', 'n/a', 'na', 'none']);

/** `software-engineering` becomes `Software Engineering`; `other` / `unknown` give null. */
export function humaniseSlug(value: unknown): string | null {
  const text = trimmed(value);
  if (!text || EMPTY_LABELS.has(text.toLowerCase())) return null;
  return text
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Seniority as given (`senior`, `lead`), or null for `unknown`. */
export function seniorityLabel(value: unknown): string | null {
  const text = trimmed(value);
  return text && !EMPTY_LABELS.has(text.toLowerCase()) ? text : null;
}

/** Case-insensitive, order-preserving union of string arrays. */
export function mergeSkills(...lists: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const text = trimmed(entry);
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
  }
  return out;
}

// ── URLs ────────────────────────────────────────────────────────────────────

/** An http(s) URL, re-serialised; anything else gives null. */
export function httpUrlOrNull(raw: unknown): string | null {
  const text = trimmed(raw);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,254})$/i;

/** A Level listing or company slug; anything else gives null. */
export function cleanSlug(value: unknown): string | null {
  const text = trimmed(value);
  return text && SLUG_RE.test(text) ? text.toLowerCase() : null;
}

function isLevelHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === JOBSBYLEVEL_HOST || h === `www.${JOBSBYLEVEL_HOST}`;
}

/** The slug of an `https://jobsbylevel.com/jobs/<slug>` URL, or null. */
export function slugFromJobUrl(raw: unknown): string | null {
  const text = trimmed(raw);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || !isLevelHost(url.hostname)) return null;
    if (!url.pathname.startsWith(JOBSBYLEVEL_JOB_PATH)) return null;
    const rest = url.pathname.slice(JOBSBYLEVEL_JOB_PATH.length).replace(/\/+$/, '');
    if (!rest || rest.includes('/') || rest.toLowerCase() === 'edit') return null;
    return cleanSlug(rest);
  } catch {
    return null;
  }
}

/** Board page of a company on Level (matches the JSON-LD `hiringOrganization.url`). */
export function companyBoardUrl(companySlug: string | null): string | null {
  const slug = cleanSlug(companySlug);
  return slug ? `${JOBSBYLEVEL_BASE_URL}${JOBSBYLEVEL_COMPANY_PATH}${slug}` : null;
}

/**
 * True for the only URLs this plugin may request: https on the Level host, no
 * query string, and not under a robots.txt-disallowed prefix.
 */
export function isAllowedJobsByLevelUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== JOBSBYLEVEL_HOST) return false;
    if (url.search || url.username || url.password || url.port) return false;
    const path = url.pathname.toLowerCase();
    return !JOBSBYLEVEL_DISALLOWED_PATH_PREFIXES.some(
      (prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix),
    );
  } catch {
    return false;
  }
}

/** Lower-case, non-alphanumerics folded to single hyphens ("Culture Amp" becomes `culture-amp`). */
export function slugifyName(value: unknown): string | null {
  const text = trimmed(value);
  if (!text) return null;
  const slug = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}

// ── Company ─────────────────────────────────────────────────────────────────

export function companyFields(item: JobsByLevelItem): {
  name: string | null;
  slug: string | null;
  website: string | null;
} {
  const company = item.company;
  if (isObject(company)) {
    const obj = company as JobsByLevelCompanyObject;
    return {
      name: trimmed(obj.name),
      slug: cleanSlug(obj.slug) ?? cleanSlug(item.company_slug),
      website: httpUrlOrNull(obj.website) ?? httpUrlOrNull(item.company_website),
    };
  }
  return {
    name: trimmed(company),
    slug: cleanSlug(item.company_slug),
    website: httpUrlOrNull(item.company_website),
  };
}

// ── MCP (JSON-RPC over Streamable HTTP) ─────────────────────────────────────

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The JSON-RPC message inside an SSE body (`data:` lines), or undefined. */
function parseSseMessage(text: string): unknown {
  const events = text.split(/\r?\n\r?\n/);
  for (const event of events) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    const message = parseJson(data);
    if (isObject(message) && ('result' in message || 'error' in message)) return message;
  }
  return undefined;
}

/**
 * Unwrap a `tools/call` response to the tool's JSON payload. Accepts a parsed
 * JSON body, a JSON string or an SSE stream. HTML (a challenge or error page)
 * is `blocked`; a JSON-RPC or tool error, or any other shape, carries its
 * message.
 */
export function parseMcpToolPayload(data: unknown): unknown {
  let body: unknown = data;
  if (typeof body === 'string') {
    const text = body.trim();
    if (text.startsWith('<')) {
      throw responseError('blocked', 'non-JSON (HTML) body from the MCP endpoint');
    }
    body = parseJson(text) ?? parseSseMessage(text);
  }
  if (!isObject(body)) throw responseError('unknown', 'unexpected MCP response body');

  const rpc = body as JobsByLevelRpcResponse;
  if (rpc.error) {
    const code = rpc.error.code;
    const message = `MCP error ${code ?? '?'}: ${rpc.error.message ?? 'no message'}`;
    throw responseError(code === -32602 ? 'bad_input' : 'unknown', message);
  }
  const result = rpc.result;
  if (!isObject(result)) throw responseError('unknown', 'MCP response without a result');

  const text = Array.isArray(result.content)
    ? result.content.find((c) => c?.type === 'text' && typeof c.text === 'string')?.text
    : undefined;

  if (result.isError) {
    const message = `MCP tool error: ${text ?? 'no message'}`;
    throw responseError(/rate.?limit|too many requests|\b429\b/i.test(message) ? 'fetch_error' : 'unknown', message);
  }
  if (isObject(result.structuredContent)) return result.structuredContent;
  if (!text) throw responseError('unknown', 'MCP tool result has no text content');
  const payload = parseJson(text);
  if (payload === undefined) throw responseError('unknown', 'MCP tool text is not JSON');
  return payload;
}

/** An object with an `items` array. */
export function isSearchEnvelope(value: unknown): value is JobsByLevelSearchEnvelope {
  return isObject(value) && Array.isArray(value.items);
}

/** A `get_job` payload: an object naming a listing. */
export function isDetailItem(value: unknown): value is JobsByLevelItem {
  return isObject(value) && (typeof value.slug === 'string' || typeof value.id === 'string');
}

/** The plain-text detail a `get_job` payload adds. */
export function detailFromMcpItem(item: JobsByLevelItem): JobsByLevelDetail {
  const description = trimmed(item.description_text);
  return {
    description,
    descriptionIsHtml: false,
    skills: mergeSkills(item.tools, item.skills),
    companyWebsite: companyFields(item).website,
    countryCode: normaliseCountryCode(item.country),
    remote: item.remote === undefined || item.remote === null ? null : isTruthyFlag(item.remote),
    aiLevel: resolveAiLevel(item),
    compensation: buildCompensation(item),
    employmentType: trimmed(item.employment_type),
    atsId: null,
  };
}

// ── RSS feed ────────────────────────────────────────────────────────────────

function readTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = re.exec(block);
  if (!match) return null;
  const inner = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return decodeHtmlEntities(cdata ? cdata[1] : inner).trim() || null;
}

/** "Title at Company", split at the LAST " at " (titles can contain one). */
export function splitTitleCompany(raw: string): { title: string; companyName: string | null } {
  const index = raw.toLowerCase().lastIndexOf(' at ');
  if (index <= 0) return { title: raw.trim(), companyName: null };
  const title = raw.slice(0, index).trim();
  const companyName = raw.slice(index + 4).trim();
  return title && companyName ? { title, companyName } : { title: raw.trim(), companyName: null };
}

/** Does this body look like an RSS document at all? */
export function looksLikeRss(body: string): boolean {
  return /<rss\b|<channel\b/i.test(body.slice(0, 4096));
}

/**
 * Parse `/feed.xml` items, newest first as served. Items without a listing
 * link are skipped; a slug seen twice is kept once (the same title can appear
 * under two slugs, which are two listings).
 */
export function parseRssFeed(xml: string, maxItems: number): JobsByLevelFeedItem[] {
  const out: JobsByLevelFeedItem[] = [];
  const seen = new Set<string>();
  const blocks = xml.split(/<item\b[^>]*>/i).slice(1);
  for (const block of blocks) {
    if (out.length >= maxItems) break;
    const content = block.split(/<\/item>/i)[0] ?? '';
    const link = readTag(content, 'link') ?? readTag(content, 'guid');
    const slug = slugFromJobUrl(link);
    const rawTitle = readTag(content, 'title');
    if (!slug || !rawTitle || seen.has(slug)) continue;
    seen.add(slug);

    const { title, companyName } = splitTitleCompany(rawTitle);
    const pubDate = readTag(content, 'pubDate');
    const pubMs = pubDate ? Date.parse(pubDate) : Number.NaN;
    const snippet = readTag(content, 'description');

    out.push({
      slug,
      url: `${JOBSBYLEVEL_BASE_URL}${JOBSBYLEVEL_JOB_PATH}${slug}`,
      title,
      companyName,
      postedAt: Number.isFinite(pubMs) ? new Date(pubMs).toISOString() : null,
      snippet: snippet ? stripHtmlTags(snippet).replace(/\s+/g, ' ').trim() || null : null,
    });
  }
  return out;
}

// ── Listing page (JSON-LD) ──────────────────────────────────────────────────

function findRawJobPosting(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRawJobPosting(entry);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  const type = value['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return value;
  return findRawJobPosting(value['@graph']);
}

function countryFromRequirements(value: unknown): string | null {
  const list = Array.isArray(value) ? value : [value];
  for (const entry of list) {
    if (typeof entry === 'string') {
      const code = normaliseCountryCode(entry);
      if (code) return code;
    } else if (isObject(entry)) {
      const code = normaliseCountryCode(entry.name) ?? normaliseCountryCode(entry.addressCountry);
      if (code) return code;
    }
  }
  return null;
}

/**
 * What a listing page adds: the JobPosting JSON-LD (HTML description, salary,
 * remote flag, employer ATS id), the country from
 * `applicantLocationRequirements` (the shared parser does not read it) and the
 * AI level from the visible badge. Null when the page has no JobPosting.
 */
export function parseDetailPage(html: string): JobsByLevelDetail | null {
  const ld = parseJobPostingLd(html)[0];
  if (!ld) return null;

  let raw: Record<string, unknown> | null = null;
  for (const block of extractLdJsonBlocks(html)) {
    raw = findRawJobPosting(block);
    if (raw) break;
  }
  const identifier = raw && isObject(raw.identifier) ? raw.identifier.value : undefined;
  const atsId =
    typeof identifier === 'string' || typeof identifier === 'number' ? String(identifier).trim() || null : null;

  const website = httpUrlOrNull(ld.hiringOrganizationUrl);
  let companyWebsite: string | null = null;
  if (website) {
    try {
      companyWebsite = isLevelHost(new URL(website).hostname) ? null : website;
    } catch {
      companyWebsite = null;
    }
  }

  return {
    description: trimmed(ld.description),
    descriptionIsHtml: true,
    skills: [],
    companyWebsite,
    countryCode: raw ? countryFromRequirements(raw.applicantLocationRequirements) : null,
    remote: ld.remote ? true : null,
    aiLevel: aiLevelFromPageHtml(html),
    compensation: jobPostingLdToCompensation(ld.baseSalary),
    employmentType: trimmed(ld.employmentType),
    atsId,
  };
}

// ── Environment and input ───────────────────────────────────────────────────

/** Boolean env var: `false` / `0` / `no` / `off` is false, any other value true, unset the default. */
export function readEnvFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/** Integer env var inside [min, max]; unset or invalid gives undefined. */
export function readEnvInt(name: string, min: number, max: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = toFiniteNumber(raw);
  if (n === null || !Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

/** Comma-separated env var, trimmed, lower-cased, empties dropped; null when none. */
export function readEnvCsv(name: string): string[] | null {
  const raw = process.env[name];
  if (!raw) return null;
  const values = raw
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return values.length ? values : null;
}

/** Detail reads allowed for a `descriptionDepth` (default `detail-25`: 5). */
export function detailBudgetFor(depth: string | undefined | null): number {
  if (depth && Object.prototype.hasOwnProperty.call(JOBSBYLEVEL_DETAIL_BUDGET, depth)) {
    return JOBSBYLEVEL_DETAIL_BUDGET[depth as keyof typeof JOBSBYLEVEL_DETAIL_BUDGET];
  }
  return JOBSBYLEVEL_DETAIL_BUDGET['detail-25'];
}

/** Deterministic JSON with sorted keys, for cache keys. */
export function stableStringify(value: Record<string, unknown>): string {
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys.map((k) => [k, value[k]]));
}
