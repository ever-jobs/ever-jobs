import * as cheerio from 'cheerio';
import {
  htmlToPlainText,
  isPubliclyRoutableHostname,
  parseLocationList,
  pinUrlToHosts,
  PostedTime,
  regionNameFromCode,
} from '@ever-jobs/common';
import { getJobTypeFromString, JobType, LocationDto } from '@ever-jobs/models';
import {
  INHIRE_BRAZIL_STATE_CODES,
  INHIRE_CANONICAL_HOST_SUFFIX,
  INHIRE_CONTRACT_TYPE_MAP,
  INHIRE_DEFAULT_COUNTRY,
  INHIRE_DEFAULT_COUNTRY_CODE,
  INHIRE_DEFAULT_DETAIL_BUDGET,
  INHIRE_DETAIL_25_BUDGET,
  INHIRE_INTERNSHIP_TITLE_RE,
  INHIRE_JOB_ID_RE,
  INHIRE_JOB_PATH,
  INHIRE_MAX_DETAIL_FETCHES,
  INHIRE_RESERVED_LABELS,
  INHIRE_TENANT_HOST_SUFFIXES,
  INHIRE_TENANT_RE,
  INHIRE_WORKPLACE_WORDS,
} from './inhire.constants';
import { InhireCandidate, InhireListItem, InhireLocationLabel } from './inhire.types';

/**
 * Pure helpers for the InHire adapter (Spec 1692). None of them performs I/O,
 * reads the clock or throws on bad input.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A URL scheme followed by `//`. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Whitespace or an ASCII control character anywhere in a tenant value. */
const UNSAFE_TENANT_CHARS_RE = /[\s\u0000-\u001f\u007f]/;

/** Lower-case, accent-free, whitespace-collapsed form used for every text comparison. */
export function foldText(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trim and collapse whitespace; null for a non-string or an empty result. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Only the ASCII letters of `brasil` / `brazil` differ, so both fold to one spelling. */
function foldBrazil(value: string): string {
  return value.replace(/\bbrasil\b/g, 'brazil');
}

export interface ParseTenantOptions {
  /** Refuse a bare slug: the value must name a tenant host (used for `companyUrl`). */
  hostOnly?: boolean;
}

/**
 * The tenant named by a `companySlug` / `companyUrl` value, or null.
 *
 * Accepted: a bare slug (`olist`, `ACME-BR`), a tenant host (`olist.inhire.app`)
 * or a URL on `*.inhire.app` / `*.inhire.com.br`
 * (`https://olist.inhire.com.br/vagas/<id>`). The tenant is the single label in
 * front of the suffix, lower-cased, and must be a valid DNS label that is not
 * InHire infrastructure (`api`, `files`, `www`). Anything carrying whitespace,
 * a control character, credentials or an explicit port is refused, so a value
 * can never smuggle a header line or point a request elsewhere.
 */
export function parseInhireTenant(
  value: string | null | undefined,
  options: ParseTenantOptions = {},
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || UNSAFE_TENANT_CHARS_RE.test(trimmed)) return null;

  const looksLikeHost = SCHEME_RE.test(trimmed) || /[./:@]/.test(trimmed);
  if (!looksLikeHost) {
    if (options.hostOnly) return null;
    return validTenantLabel(trimmed.toLowerCase());
  }

  let url: URL;
  try {
    url = new URL(SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.port) return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  for (const suffix of INHIRE_TENANT_HOST_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return validTenantLabel(host.slice(0, host.length - suffix.length));
    }
  }
  return null;
}

function validTenantLabel(label: string): string | null {
  if (!INHIRE_TENANT_RE.test(label)) return null;
  if (INHIRE_RESERVED_LABELS.has(label)) return null;
  return label;
}

/** Display name from a tenant slug when the detail carries no brand: `acme-br` → `Acme Br`. */
export function tenantDisplayName(tenant: string): string {
  return tenant
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** True for a UUID-shaped role id. */
export function isInhireJobId(value: unknown): value is string {
  return typeof value === 'string' && INHIRE_JOB_ID_RE.test(value);
}

export interface CleanedList {
  candidates: InhireCandidate[];
  /** Rows beyond the cap (dropped before cleaning). */
  truncated: number;
  /** Rows without a UUID id or a title. */
  invalid: number;
  /** Rows repeating an id already seen. */
  dupe: number;
}

/**
 * Cap the raw list, drop rows without a UUID `jobId` or a title, and
 * de-duplicate by id (case-insensitive) in first-seen order.
 */
export function cleanListRows(rows: readonly unknown[], maxItems: number): CleanedList {
  const capped = rows.slice(0, Math.max(0, maxItems));
  const seen = new Set<string>();
  const candidates: InhireCandidate[] = [];
  let invalid = 0;
  let dupe = 0;
  for (const row of capped) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      invalid++;
      continue;
    }
    const item = row as InhireListItem;
    const title = cleanText(item.displayName);
    if (!isInhireJobId(item.jobId) || !title) {
      invalid++;
      continue;
    }
    const key = item.jobId.toLowerCase();
    if (seen.has(key)) {
      dupe++;
      continue;
    }
    seen.add(key);
    candidates.push({
      index: candidates.length,
      jobId: item.jobId,
      title,
      link: typeof item.link === 'string' ? item.link : null,
    });
  }
  return { candidates, truncated: rows.length - capped.length, invalid, dupe };
}

/** Every whitespace-separated word of `term` appears in `title` (case- and accent-insensitive). */
export function matchesSearchTerm(title: string, term: string | null | undefined): boolean {
  const words = foldText(term).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const haystack = foldText(title);
  return words.every((word) => haystack.includes(word));
}

/**
 * Public job URL: the list `link` when it is an https URL on the tenant's own
 * host (`{tenant}.inhire.com.br` or `{tenant}.inhire.app`, no credentials,
 * no port, no other sub-domain), else the canonical
 * `https://{tenant}.inhire.com.br/vagas/{jobId}`.
 */
export function resolveJobUrl(link: string | null, tenant: string, jobId: string): string {
  const pinned = pinUrlToHosts(
    link,
    INHIRE_TENANT_HOST_SUFFIXES.map((suffix) => `${tenant}${suffix}`),
    { allowSubdomains: false },
  );
  return pinned ?? canonicalJobUrl(tenant, jobId);
}

export function canonicalJobUrl(tenant: string, jobId: string): string {
  return `https://${tenant}${INHIRE_CANONICAL_HOST_SUFFIX}/${INHIRE_JOB_PATH}/${encodeURIComponent(jobId)}`;
}

/** The career-page URL for a job URL: its origin plus `/vagas`. */
export function careerPageUrl(jobUrl: string): string | null {
  try {
    return `${new URL(jobUrl).origin}/${INHIRE_JOB_PATH}`;
  } catch {
    return null;
  }
}

/** An https URL on a public host without credentials, normalised; else null. */
export function httpsUrlOrNull(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!isPubliclyRoutableHostname(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The first https entry of a string array (the tenant's banner list). */
export function firstHttpsUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return httpsUrlOrNull(value);
  for (const entry of value) {
    const url = httpsUrlOrNull(entry);
    if (url) return url;
  }
  return null;
}

/**
 * Rewrite named HTML entities (`&atilde;`, `&ccedil;`, `&ordm;` …) as the
 * characters they stand for, keeping the markup and the five
 * markup-significant escapes intact. The shared plain-text converter only
 * knows a handful of entities, and the API entity-encodes every accent.
 */
export function normaliseHtmlEntities(html: string): string {
  if (!html.includes('&')) return html;
  try {
    return cheerio.load(html, null, false).html();
  } catch {
    return html;
  }
}

/** HTML to plain text with every entity decoded; null when nothing is left. */
export function htmlToText(html: string | null | undefined): string | null {
  if (typeof html !== 'string' || !html.trim()) return null;
  const text = htmlToPlainText(normaliseHtmlEntities(html));
  return text ? text : null;
}

/** Comma-separated parts of a free-text location, normalised for the parser. */
function locationParts(value: string): string[] {
  return value
    .replace(/\s+[-–—]\s+/g, ', ')
    .replace(/\s*\/\s*/g, ', ')
    .split(',')
    .map((part) => part.replace(/\bbrasil\b/gi, INHIRE_DEFAULT_COUNTRY).replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0 && !INHIRE_WORKPLACE_WORDS.has(foldText(part)));
}

/**
 * Build the label handed to `parseLocationList` from the detail's `location`
 * and `locationComplement`.
 *
 * - A two-letter ISO country code (`BR`) is passed as-is and becomes the
 *   `countryCode`; a complement is placed in front of the country's name.
 * - Free text has ` - ` / ` – ` / `/` separators turned into commas, `Brasil`
 *   spelled `Brazil`, and workplace words (`Remoto`, `Híbrido`, `Presencial`)
 *   dropped. `, Brazil` is appended unless the label already names a country:
 *   a trailing Brazilian state code (`PR`, `RS`, `SC` …) never counts as one,
 *   because several of them are also ISO country codes.
 * - Nothing left means no location.
 */
export function buildLocationLabel(
  location: string | null | undefined,
  complement: string | null | undefined,
): InhireLocationLabel {
  const raw = cleanText(location) ?? '';
  const extra = cleanText(complement) ?? '';

  if (/^[A-Za-z]{2}$/.test(raw)) {
    const code = raw.toUpperCase();
    const countryName = regionNameFromCode(code);
    if (countryName) {
      const extraParts = extra ? locationParts(extra) : [];
      if (extraParts.length === 0) return { label: code, countryCode: code };
      return { label: [...extraParts, countryName].join(', '), countryCode: code };
    }
  }

  const parts: string[] = [];
  const seen = new Set<string>();
  for (const part of [...locationParts(raw), ...locationParts(extra)]) {
    const key = foldText(part);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(part);
  }
  if (parts.length === 0) return { label: null, countryCode: null };

  const label = parts.join(', ');
  const last = parts[parts.length - 1].toUpperCase();
  const endsInState = INHIRE_BRAZIL_STATE_CODES.has(last);
  const namedCountry = endsInState ? null : cleanText(parseLocationList([label]).location?.country);
  if (!namedCountry) {
    return { label: `${label}, ${INHIRE_DEFAULT_COUNTRY}`, countryCode: INHIRE_DEFAULT_COUNTRY_CODE };
  }
  return {
    label,
    countryCode: foldText(namedCountry) === foldText(INHIRE_DEFAULT_COUNTRY) ? INHIRE_DEFAULT_COUNTRY_CODE : null,
  };
}

/**
 * Location filter: every comma-separated part of `needle` appears in the
 * label or in a parsed city / state / country, ignoring case and accents, with
 * `Brasil` and `Brazil` treated as one word.
 */
export function matchesLocation(
  needle: string | null | undefined,
  label: string | null,
  locations: ReadonlyArray<LocationDto | null | undefined>,
): boolean {
  const parts = foldBrazil(foldText(needle))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return true;
  const fields: string[] = [label ?? ''];
  for (const loc of locations) {
    if (!loc) continue;
    for (const value of [loc.city, loc.state, loc.country]) {
      if (typeof value === 'string') fields.push(value);
    }
  }
  const haystack = foldBrazil(foldText(fields.join(' | ')));
  return parts.every((part) => haystack.includes(part));
}

/**
 * Job types from the Brazilian contract labels plus an internship title. The
 * plugin's own map is tried first, then the shared resolver; unknown labels are
 * ignored. De-duplicated; null when nothing maps.
 */
export function mapContractTypes(contractType: unknown, title: string | null): JobType[] | null {
  const labels = Array.isArray(contractType) ? contractType : [contractType];
  const types: JobType[] = [];
  const add = (type: JobType | null | undefined) => {
    if (type && !types.includes(type)) types.push(type);
  };
  for (const label of labels) {
    const text = cleanText(label);
    if (!text) continue;
    add(INHIRE_CONTRACT_TYPE_MAP.get(foldText(text)) ?? getJobTypeFromString(text));
  }
  if (title && INHIRE_INTERNSHIP_TITLE_RE.test(foldText(title))) add(JobType.INTERNSHIP);
  return types.length > 0 ? types : null;
}

/** Contract labels joined as the raw `employmentType`, e.g. `CLT`; null when none. */
export function employmentTypeLabel(contractType: unknown): string | null {
  const labels = (Array.isArray(contractType) ? contractType : [contractType])
    .map((label) => cleanText(label))
    .filter((label): label is string => label !== null);
  return labels.length > 0 ? Array.from(new Set(labels)).join(', ') : null;
}

/** Workplace type as `isRemote` + the parser's `workFromHomeType` vocabulary. */
export function workplaceFlags(workplaceType: unknown): {
  isRemote: boolean;
  workFromHomeType: 'Remote' | 'Hybrid' | null;
} {
  const key = foldText(cleanText(workplaceType));
  if (key === 'remote' || key === 'remoto') return { isRemote: true, workFromHomeType: 'Remote' };
  if (key === 'hybrid' || key === 'hibrido') return { isRemote: false, workFromHomeType: 'Hybrid' };
  return { isRemote: false, workFromHomeType: null };
}

/**
 * The latest instant a posting time allows, for an hours-based freshness
 * filter: the exact instant when there is one, else the end of the posted day
 * (so a day-bucketed role is never dropped for a time of day nobody knows).
 * Null when there is no date.
 */
export function latestPostedMs(posted: PostedTime): number | null {
  const at = posted.datePostedAt ? Date.parse(posted.datePostedAt) : Number.NaN;
  if (Number.isFinite(at)) return at;
  if (typeof posted.datePosted !== 'string') return null;
  const day = Date.parse(`${posted.datePosted.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(day) ? day + DAY_MS - 1 : null;
}

/** Detail-call budget for a `descriptionDepth`, never above the hard ceiling. */
export function detailBudgetFor(depth: string | null | undefined): number {
  switch (depth) {
    case 'board':
      return 0;
    case 'detail-25':
      return INHIRE_DETAIL_25_BUDGET;
    case 'detail-all':
      return INHIRE_MAX_DETAIL_FETCHES;
    default:
      return Math.min(INHIRE_DEFAULT_DETAIL_BUDGET, INHIRE_MAX_DETAIL_FETCHES);
  }
}

/** Integer env var clamped to [min, max]; unset or not an integer gives the fallback. */
export function readEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Text of an error body's `message`, trimmed and capped; null when absent. */
export function bodyMessage(body: unknown, maxLength: number): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const message = cleanText((body as { message?: unknown }).message);
  return message ? message.slice(0, maxLength) : null;
}

/** Parse a JSON text body (the client may hand one back unparsed); other values pass through. */
export function parseJsonBody(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  const text = data.trim();
  if (!text.startsWith('[') && !text.startsWith('{')) return data;
  try {
    return JSON.parse(text);
  } catch {
    return data;
  }
}
