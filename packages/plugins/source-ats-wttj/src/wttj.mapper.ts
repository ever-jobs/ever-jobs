/**
 * Pure hit-mapping helpers for the Welcome to the Jungle (WTTJ) plugin (Spec 1705 work
 * item B). Every function here is total: bad or missing input gives `null` / `[]`, never
 * a throw, so one malformed hit cannot break a scrape. Company mode and board mode share
 * all of them.
 */
import {
  CompensationDto,
  CompensationInterval,
  getCompensationInterval,
  getJobTypeFromString,
  JobType,
  LocationDto,
} from '@ever-jobs/models';
import {
  WTTJ_DEFAULT_LANG,
  WTTJ_REMOTE_REGEX,
  WTTJ_URL_LOCALES,
} from './wttj.constants';
import { WttjJobHit, WttjOffice, WttjOrganization, WttjSector } from './wttj.types';

/** Trim a string, returning null for empty / non-string values. */
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.length > 0 ? v : null;
}

/** A finite number strictly greater than zero, else null. */
function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// ── Remote policy (B1) ──────────────────────────────────────────────────────

/** How a posting's remote policy maps onto `isRemote` + `workFromHomeType`. */
export interface WttjRemoteResult {
  /** True only for fully remote roles. */
  isRemote: boolean;
  /** `Remote` for fully remote, `Hybrid` for partial / occasional remote, else null. */
  workFromHomeType: 'Remote' | 'Hybrid' | null;
}

/**
 * The remote tokens the index uses, with their meaning. `isRemote` means fully remote
 * (the convention the Ashby plugin follows); hybrid arrangements go to
 * `workFromHomeType` only.
 */
export const WTTJ_REMOTE_TOKENS: Readonly<Record<string, WttjRemoteResult>> = Object.freeze({
  fulltime: { isRemote: true, workFromHomeType: 'Remote' },
  partial: { isRemote: false, workFromHomeType: 'Hybrid' },
  punctual: { isRemote: false, workFromHomeType: 'Hybrid' },
});

/** Tokens that state "no remote work"; the free-text fallback is not consulted for them. */
const NO_REMOTE_TOKEN_RE = /^(?:no|none|false|onsite|on[\s-]?site)$/i;

function textSaysRemote(fallbackText: ReadonlyArray<string | null | undefined>): boolean {
  for (const field of fallbackText) {
    if (typeof field === 'string' && WTTJ_REMOTE_REGEX.test(field)) return true;
  }
  return false;
}

/**
 * Map the structured `remote` token (Spec 1705 B1).
 *
 * - `fulltime` → remote; `partial` / `punctual` → hybrid, not remote.
 * - `no` (and the other explicit "on-site" spellings) → not remote; the title is not read,
 *   because the structured value wins.
 * - `unknown`, a missing token or any unrecognised token → the remote regex over
 *   `fallbackText` (title, office city / state, profession).
 */
export function remoteFromToken(
  token: string | null | undefined,
  fallbackText: ReadonlyArray<string | null | undefined>,
): WttjRemoteResult {
  const key = clean(token)?.toLowerCase() ?? null;
  if (key && Object.prototype.hasOwnProperty.call(WTTJ_REMOTE_TOKENS, key)) {
    return { ...WTTJ_REMOTE_TOKENS[key] };
  }
  if (key && NO_REMOTE_TOKEN_RE.test(key)) return { isRemote: false, workFromHomeType: null };
  return textSaysRemote(fallbackText)
    ? { isRemote: true, workFromHomeType: 'Remote' }
    : { isRemote: false, workFromHomeType: null };
}

/**
 * The pre-Spec-1705 remote rule, kept for `WTTJ_REMOTE_MODE=legacy`: any token other than
 * an explicit "no" counts as remote (so `unknown`, `partial` and `punctual` do too), and
 * without a token the remote regex decides.
 */
export function legacyRemoteFromToken(
  token: string | null | undefined,
  fallbackText: ReadonlyArray<string | null | undefined>,
): boolean {
  const key = clean(token);
  if (key && !NO_REMOTE_TOKEN_RE.test(key)) return true;
  return textSaysRemote(fallbackText);
}

// ── Contract type → JobType (B4) ────────────────────────────────────────────

/**
 * Every `contract_type` token seen live on 2026-09-24, with its canonical job type.
 * `temporary` is the French fixed-term contract. `apprenticeship` (work-study) maps to
 * the dedicated `APPRENTICESHIP` member.
 */
export const WTTJ_CONTRACT_JOB_TYPES: Readonly<Record<string, JobType>> = Object.freeze({
  full_time: JobType.FULL_TIME,
  part_time: JobType.PART_TIME,
  internship: JobType.INTERNSHIP,
  apprenticeship: JobType.APPRENTICESHIP,
  temporary: JobType.TEMPORARY,
  freelance: JobType.CONTRACT,
  volunteer: JobType.VOLUNTEER,
  other: JobType.OTHER,
  vie: JobType.OTHER,
  graduate_program: JobType.OTHER,
  idv: JobType.OTHER,
});

/**
 * Job types for a `contract_type` token: the table above, then the shared job-type
 * vocabulary (for a token the board adds later), then `OTHER`. A missing token gives
 * null.
 */
export function jobTypesFromContract(
  token: string | null | undefined,
  language?: string | null,
): JobType[] | null {
  const key = clean(token)?.toLowerCase() ?? null;
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(WTTJ_CONTRACT_JOB_TYPES, key)) {
    return [WTTJ_CONTRACT_JOB_TYPES[key]];
  }
  const shared = getJobTypeFromString(key, { locale: clean(language) });
  return [shared ?? JobType.OTHER];
}

/** The `contract_type` tokens that map to `jobType` (the reverse of the table). */
export function contractTokensForJobType(jobType: JobType | null | undefined): string[] {
  if (!jobType) return [];
  return Object.entries(WTTJ_CONTRACT_JOB_TYPES)
    .filter(([, mapped]) => mapped === jobType)
    .map(([token]) => token);
}

// ── Salary (B3) ─────────────────────────────────────────────────────────────

/**
 * The structured salary on a hit, or null (Spec 1705 B3).
 *
 * - `salary_minimum` / `salary_maximum` when either is positive, with the interval from
 *   `salary_period` (an unknown period gives no interval);
 * - otherwise `salary_yearly_minimum` as a yearly floor;
 * - never without a three-letter currency: `CompensationDto` would default it to USD,
 *   which is wrong for most of this board.
 */
export function structuredCompensation(hit: WttjJobHit): CompensationDto | null {
  const currency = clean(hit.salary_currency)?.toUpperCase() ?? null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;

  let min = positive(hit.salary_minimum);
  let max = positive(hit.salary_maximum);
  if (min !== null || max !== null) {
    if (min !== null && max !== null && min > max) [min, max] = [max, min];
    const period = clean(hit.salary_period);
    return new CompensationDto({
      minAmount: min ?? undefined,
      maxAmount: max ?? undefined,
      currency,
      interval: (period ? getCompensationInterval(period) : null) ?? undefined,
    });
  }

  const yearlyMin = positive(hit.salary_yearly_minimum);
  if (yearlyMin !== null) {
    return new CompensationDto({
      minAmount: yearlyMin,
      interval: CompensationInterval.YEARLY,
      currency,
    });
  }
  return null;
}

// ── Description (B2) ────────────────────────────────────────────────────────

/** Escape the five HTML-special characters. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The non-empty mission sentences of a hit, whether the index sent a list or a string. */
export function missionsOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => clean(item)).filter((item): item is string => !!item);
  }
  const single = clean(value);
  return single ? [single] : [];
}

/**
 * The job-ad body as HTML (Spec 1705 B2): the summary, the key missions as a list, then
 * the profile (already HTML), each only when present, joined by newlines. A legacy
 * single-string missions value is kept as a paragraph.
 */
export function assembleDescriptionHtml(hit: WttjJobHit): string | null {
  const parts: string[] = [];
  const summary = clean(hit.summary);
  if (summary) parts.push(`<p>${escapeHtml(summary)}</p>`);

  if (Array.isArray(hit.key_missions)) {
    const missions = missionsOf(hit.key_missions);
    if (missions.length > 0) {
      parts.push(`<ul>${missions.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`);
    }
  } else {
    const mission = clean(hit.key_missions);
    if (mission) parts.push(`<p>${escapeHtml(mission)}</p>`);
  }

  const profile = clean(hit.profile);
  if (profile) parts.push(profile);
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * The pre-Spec-1705 body, kept for `WTTJ_DESCRIPTION_LAYOUT=legacy`: a string
 * `key_missions` plus `profile` (a list of missions is dropped, as it was), falling back to
 * the summary only when both are empty.
 */
export function legacyAssembleDescription(hit: WttjJobHit): string | null {
  const parts = [hit.key_missions, hit.profile]
    .map((p) => clean(p))
    .filter((p): p is string => !!p);
  if (parts.length > 0) return parts.join('\n\n');
  return clean(hit.summary);
}

// ── Offices and locations (B5) ──────────────────────────────────────────────

/** A validated, upper-cased ISO alpha-2 code from an office, or null. */
export function officeCountryCode(office: WttjOffice | null | undefined): string | null {
  const code = clean(office?.country_code)?.toUpperCase() ?? null;
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * The country code of the primary office, else the first office that has a valid one.
 */
export function countryCodeFromOffices(
  offices: WttjOffice[] | null | undefined,
  primary: WttjOffice | null | undefined,
): string | null {
  const fromPrimary = officeCountryCode(primary);
  if (fromPrimary) return fromPrimary;
  if (!Array.isArray(offices)) return null;
  for (const office of offices) {
    const code = officeCountryCode(office);
    if (code) return code;
  }
  return null;
}

/**
 * One location per office, deduplicated on city | state | country (case-insensitive), in
 * office order. Offices with no city, state or country are skipped. These are structured
 * wire fields, so they pass straight through.
 */
export function officeLocations(offices: WttjOffice[] | null | undefined): LocationDto[] {
  if (!Array.isArray(offices)) return [];
  const seen = new Set<string>();
  const out: LocationDto[] = [];
  for (const office of offices) {
    if (!office || typeof office !== 'object') continue;
    const city = clean(office.city);
    const state = clean(office.state);
    const country = clean(office.country);
    if (!city && !state && !country) continue;
    const key = [city, state, country].map((p) => (p ?? '').toLowerCase()).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(new LocationDto({ city, state, country }));
  }
  return out;
}

/** The dedupe key {@link officeLocations} uses, for a location built elsewhere. */
export function locationKey(location: LocationDto): string {
  return [location.city, location.state, location.country]
    .map((p) => (typeof p === 'string' ? p.trim().toLowerCase() : ''))
    .join('|');
}

// ── Company metadata (B5) ───────────────────────────────────────────────────

/** The company logo URL (http(s) only). */
export function companyLogoUrl(org: WttjOrganization | null | undefined): string | null {
  const url = clean(org?.logo?.url);
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** The headcount as a string, when it is a positive number. */
export function companyNumEmployees(org: WttjOrganization | null | undefined): string | null {
  const n = positive(org?.nb_employees);
  return n === null ? null : String(n);
}

/** Sector labels, deduplicated (case-insensitive) and joined with `', '`. */
export function companyIndustry(sectors: WttjSector[] | null | undefined): string | null {
  if (!Array.isArray(sectors)) return null;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const sector of sectors) {
    const name = clean(sector?.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names.length > 0 ? names.join(', ') : null;
}

/**
 * A minimum-experience label, only when the hit flags the value as meaningful: `5+ years`,
 * `1+ year`, and months below one year (`6+ months`).
 */
export function experienceRangeFrom(hit: WttjJobHit): string | null {
  if (hit.has_experience_level_minimum !== true) return null;
  const years = positive(hit.experience_level_minimum);
  if (years === null) return null;
  if (years < 1) {
    const months = Math.round(years * 12);
    return months > 0 ? `${months}+ month${months === 1 ? '' : 's'}` : null;
  }
  const label = Number.isInteger(years) ? String(years) : String(Math.round(years * 10) / 10);
  return `${label}+ year${years === 1 ? '' : 's'}`;
}

// ── URL locale (B6) ─────────────────────────────────────────────────────────

/**
 * The URL locale for a posting. With the guard (the default) only a UI locale the site
 * serves is used and anything else becomes `en`; without it (`WTTJ_URL_LOCALE_GUARD=off`)
 * the posting language is used as-is, as before Spec 1705.
 */
export function urlLocale(language: string | null | undefined, guard: boolean): string {
  const lang = clean(language);
  if (!guard) return lang ?? WTTJ_DEFAULT_LANG;
  const lower = lang?.toLowerCase() ?? null;
  return lower && WTTJ_URL_LOCALES.has(lower) ? lower : WTTJ_DEFAULT_LANG;
}
