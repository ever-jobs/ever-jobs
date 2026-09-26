import { JobPostDto, JobType, Site } from '@ever-jobs/models';
import {
  NO_POSTED_TIME,
  normalizeCountryOnly,
  normalizeUsState,
  parseLocationList,
  PostedTime,
  postedFromTimestamp,
  postedTimeFields,
  resolveCompanyUrl,
  toDateOnly,
} from '@ever-jobs/common';
import {
  SIMPLIFYJOBS_ATS_HOSTS,
  SIMPLIFYJOBS_CA_PROVINCES,
  SIMPLIFYJOBS_DAY_SECONDS,
  SIMPLIFYJOBS_LOCATION_ALIASES,
} from './simplifyjobs.constants';
import { SimplifyRow, SimplifyVisaSponsorship } from './simplifyjobs.types';

const TWO_LETTER_CODE_RE = /^[A-Z]{2}$/;
const SHORT_REGION_CODE_RE = /^[A-Z]{2,3}$/;

/** A 2-letter upper-case US state/territory code or Canadian province code. */
function isSubdivisionCode(part: string): boolean {
  if (!TWO_LETTER_CODE_RE.test(part)) return false;
  return normalizeUsState(part) === part || Object.prototype.hasOwnProperty.call(SIMPLIFYJOBS_CA_PROVINCES, part);
}

/**
 * Rewrite the few label shapes the shared location parser reads wrongly, so
 * `parseLocationList` sees what the feed means. Suffix-first: the rightmost
 * tokens are trusted before any city name.
 *
 * 1. Whole-label shorthands: `NYC`, `SF`, `SF Bay Area` / `Bay Area`, `DC`.
 * 2. `Area, City, ST, Country` (4+ parts, a state/province code before a
 *    country) keeps the last three: `Kanata, Ottawa, ON, Canada` →
 *    `Ottawa, ON, Canada`.
 * 3. `Area, City, ST` (3+ parts ending in a US state code) keeps the last two:
 *    `Research Triangle, Durham, NC` → `Durham, NC` — unless an earlier part
 *    names a country or is a bare region code, which makes the tail a country
 *    code (`Haifa, Israel, IL` and `Chennai, TN, IN` are left alone).
 *
 * Anything else is returned trimmed and otherwise unchanged. The caller keeps
 * the raw label as `text`, so nothing is lost.
 */
export function normalizeFeedLocation(label: string): string {
  const trimmed = label.replace(/\s+/g, ' ').trim();
  const alias = SIMPLIFYJOBS_LOCATION_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  const parts = trimmed.split(',').map((p) => p.trim());
  if (parts.some((p) => p === '')) return trimmed;
  const n = parts.length;

  if (n >= 4 && normalizeCountryOnly(parts[n - 1]) !== null && isSubdivisionCode(parts[n - 2])) {
    return parts.slice(n - 3).join(', ');
  }

  if (n >= 3 && TWO_LETTER_CODE_RE.test(parts[n - 1]) && normalizeUsState(parts[n - 1]) === parts[n - 1]) {
    const dropped = parts.slice(0, n - 2);
    const middle = parts[n - 2];
    // A country or a bare region code before the tail means the tail is a
    // country code, not a state ('Haifa, Israel, IL', 'Chennai, TN, IN').
    if (
      !dropped.some((p) => normalizeCountryOnly(p) !== null) &&
      normalizeCountryOnly(middle) === null &&
      !SHORT_REGION_CODE_RE.test(middle)
    ) {
      return parts.slice(n - 2).join(', ');
    }
  }

  return trimmed;
}

/**
 * Canonical category label. Keyword rules, first match wins, so the older
 * long-form spellings land on the current labels: `Data Science, AI & Machine
 * Learning` → `AI/ML/Data`, `Quantitative Finance` → `Quant`. Anything else
 * passes through trimmed; empty or non-string → null.
 */
export function normalizeCategory(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.includes('quant')) return 'Quant';
  if (/\b(?:ai|ml|machine learning|data)\b/.test(lower)) return 'AI/ML/Data';
  if (lower.includes('hardware')) return 'Hardware';
  if (lower.includes('product')) return 'Product';
  if (lower.includes('software')) return 'Software';
  return trimmed;
}

const SPONSORSHIP: Readonly<Record<string, SimplifyVisaSponsorship>> = {
  'offers sponsorship': 'offered',
  'does not offer sponsorship': 'not_offered',
  'u.s. citizenship is required': 'citizenship_required',
};

/** The feed's sponsorship statement, normalised; `Other` and anything unknown → null. */
export function normalizeSponsorship(value: unknown): SimplifyVisaSponsorship | null {
  if (typeof value !== 'string') return null;
  return SPONSORSHIP[value.replace(/\s+/g, ' ').trim().toLowerCase()] ?? null;
}

/**
 * The applicant-tracking system behind an apply URL, from its host: the shared
 * board-host resolver first, then the host-suffix table, then a Greenhouse
 * `gh_jid` query on an employer's own domain. `null` when unknown.
 */
export function detectAtsType(url: string): string | null {
  const known = resolveCompanyUrl(url).site;
  if (known) return String(known);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  for (const [suffix, ats] of SIMPLIFYJOBS_ATS_HOSTS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return ats;
  }
  if (parsed.searchParams.has('gh_jid')) return 'greenhouse';
  return null;
}

/** A `date_posted` that is a multiple of one day: only the UTC calendar day is known. */
export function isDayGranular(epochSeconds: number): boolean {
  return epochSeconds % SIMPLIFYJOBS_DAY_SECONDS === 0;
}

/**
 * Posting time (Spec 1696). A midnight-aligned value is a calendar date
 * (`day` / `date`, no instant); any other value is the exact second the row
 * was listed (`exact` / `timestamp`). Implausible values keep a date with no
 * precision claim; a missing value gives nothing.
 */
export function postedTimeOf(row: Pick<SimplifyRow, 'datePosted'>, nowMs: number): PostedTime {
  const seconds = row.datePosted;
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return { ...NO_POSTED_TIME };
  if (isDayGranular(seconds)) {
    const day = toDateOnly(seconds * 1000);
    return day === null ? { ...NO_POSTED_TIME } : postedFromTimestamp(day, nowMs);
  }
  return postedFromTimestamp(seconds * 1000, nowMs);
}

/** Whether any of the row's terms is a summer term (`Summer 2027`). */
export function hasSummerTerm(row: Pick<SimplifyRow, 'terms'>): boolean {
  return row.terms.some((t) => /^summer\b/i.test(t));
}

export function jobTypesOf(row: Pick<SimplifyRow, 'feed' | 'terms'>): JobType[] {
  if (row.feed === 'newgrad') return [JobType.FULL_TIME];
  return hasSummerTerm(row) ? [JobType.INTERNSHIP, JobType.SUMMER] : [JobType.INTERNSHIP];
}

export function employmentTypeOf(row: Pick<SimplifyRow, 'feed' | 'terms'>): string {
  if (row.feed === 'newgrad') return 'Full-time (new grad)';
  return row.terms.length > 0 ? `Internship · ${row.terms.join(', ')}` : 'Internship';
}

/**
 * Map a compacted row to a `JobPostDto`. There is no description in the feed,
 * and none is synthesised: a templated text shared by unrelated rows would let
 * the near-duplicate stage of the dedup pipeline merge them.
 */
export function mapRowToJobPost(row: SimplifyRow, nowMs: number, site: Site): JobPostDto {
  const normalised = row.locations.map(normalizeFeedLocation);
  const parsed = parseLocationList(normalised);

  // Keep each raw label on the entry it produced when the label was rewritten:
  // by the label the parser reports, else by position when nothing was split
  // or merged (the parser may respell a label, e.g. 'USA' as 'United States').
  const rawByNormalised = new Map<string, string>();
  row.locations.forEach((raw, i) => {
    if (normalised[i] !== raw.trim()) rawByNormalised.set(normalised[i].toLowerCase(), raw.trim());
  });
  if (rawByNormalised.size > 0) {
    const aligned = parsed.locations.length === row.locations.length;
    parsed.locations.forEach((loc, i) => {
      const byLabel = rawByNormalised.get((parsed.labels[i] ?? '').toLowerCase());
      const byPosition = aligned && normalised[i] !== row.locations[i].trim() ? row.locations[i].trim() : undefined;
      const raw = byLabel ?? byPosition;
      if (raw) loc.text = raw;
    });
  }

  return new JobPostDto({
    id: `simplifyjobs-${row.id}`,
    site,
    title: row.title,
    companyName: row.companyName,
    companyUrl: row.companyUrl,
    jobUrl: row.url,
    jobUrlDirect: row.url,
    applyUrl: row.url,
    location: parsed.location,
    ...(parsed.locations.length > 0 ? { locations: parsed.locations } : {}),
    isRemote: parsed.remoteMentioned,
    workFromHomeType: parsed.workFromHomeType,
    ...postedTimeFields(postedTimeOf(row, nowMs)),
    jobType: jobTypesOf(row),
    jobLevel: row.feed === 'newgrad' ? 'Entry level' : 'Internship',
    employmentType: employmentTypeOf(row),
    jobFunction: row.category,
    atsType: detectAtsType(row.url),
    description: null,
    emails: null,
    compensation: null,
    skills: null,
  });
}
