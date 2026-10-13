import { JobPostDto, LocationDto } from '@ever-jobs/models';

/**
 * Presentation cleanup for {@link JobPostDto} values a scraper returned.
 *
 * Plugins emit strings straight from the source (ATS JSON, HTML text) — leading
 * and trailing whitespace, zero-width characters (\u200B–\u200D, \uFEFF),
 * and inner runs like `\n  ` scraped out of markup all leak through. A single
 * normalize pass at aggregation cleans them once instead of each plugin
 * remembering to.
 *
 * Rules (pure, deterministic, idempotent):
 *   - trim the extended edge set (`\s`, zero-width \u200B–\u200D, \uFEFF)
 *   - a value that is blank after trimming becomes `null`, not `''` — plugins
 *     and callers already treat empty as missing and `??` fallbacks only act
 *     on `null` (cf. rippling's `nonEmptyString`)
 *   - display-name fields (`title`, `companyName`, location text parts) also
 *     collapse interior runs to one space; ids/URLs/other fields keep interior
 *     characters — inner whitespace there is corrupt data worth surfacing
 *   - arrays (`emails`, `skills`) are cleaned per entry, empties dropped, then
 *     deduped preserving order
 *   - `site` is left alone — it is a registry token, not content
 *   - returns a new object; the input is never mutated
 */

const EDGE_WS_RE = /^[\s\u200B-\u200D\uFEFF]+|[\s\u200B-\u200D\uFEFF]+$/g;
const INNER_WS_RE = /[\s\u200B-\u200D\uFEFF]+/g;

/** Trim edges (extended set); `null` when blank. */
function cleanEnds(value: unknown): string | null | undefined {
  if (typeof value !== 'string') return value as undefined;
  const cleaned = value.replace(EDGE_WS_RE, '');
  return cleaned === '' ? null : cleaned;
}

/** Trim edges and collapse interior runs to a single space; `null` when blank. */
function cleanText(value: unknown): string | null | undefined {
  if (typeof value !== 'string') return value as undefined;
  const cleaned = value.replace(EDGE_WS_RE, '').replace(INNER_WS_RE, ' ');
  return cleaned === '' ? null : cleaned;
}

function cleanList(values: unknown): string[] | null | undefined {
  if (!Array.isArray(values)) return values as undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const cleaned = cleanEnds(value);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/** Fields cleaned with {@link cleanEnds} — ends only, interior preserved. */
const ENDS_ONLY_KEYS = [
  'id', 'atsId', 'atsType',
  'jobUrl', 'jobUrlDirect', 'applyUrl', 'companyUrl', 'companyUrlDirect',
  'companyLogo', 'bannerPhotoUrl',
  'description', 'companyDescription',
  'countryCode', 'department', 'team', 'employmentType', 'workFromHomeType',
  'listingType', 'jobLevel', 'jobFunction',
  'companyIndustry', 'companyAddresses', 'companyNumEmployees', 'companyRevenue',
  'salarySource', 'experienceRange',
] as const;

/** Fields cleaned with {@link cleanText} — ends trimmed, interior collapsed. */
const COLLAPSE_KEYS = ['title', 'companyName'] as const;

/** LocationDto/OfficeDto string parts that collapse (text-shaped). */
const LOCATION_COLLAPSE_KEYS = ['name', 'text', 'city', 'state', 'streetAddress'] as const;
/** LocationDto/OfficeDto string parts trimmed at the ends only (codes/ids). */
const LOCATION_ENDS_KEYS = ['country', 'postalCode', 'id'] as const;

function cleanLocation(location: unknown): unknown {
  if (!location || typeof location !== 'object') return location;
  const out = { ...(location as LocationDto) } as Record<string, unknown>;
  for (const key of LOCATION_COLLAPSE_KEYS) out[key] = cleanText(out[key]);
  for (const key of LOCATION_ENDS_KEYS) out[key] = cleanEnds(out[key]);
  return out;
}

export function normalizeJobPost(job: JobPostDto): JobPostDto {
  if (!job || typeof job !== 'object') return job;
  const out = { ...(job as unknown as Record<string, unknown>) };

  for (const key of ENDS_ONLY_KEYS) {
    if (key in out) out[key] = cleanEnds(out[key]);
  }
  for (const key of COLLAPSE_KEYS) {
    if (key in out) out[key] = cleanText(out[key]);
  }

  if ('emails' in out) out.emails = cleanList(out.emails);
  if ('skills' in out) out.skills = cleanList(out.skills);

  if ('location' in out) out.location = cleanLocation(out.location);
  if (Array.isArray(out.locations)) out.locations = out.locations.map(cleanLocation);
  if (Array.isArray(out.offices)) out.offices = out.offices.map(cleanLocation);

  const compensation = out.compensation;
  if (compensation && typeof compensation === 'object') {
    const comp = { ...compensation } as Record<string, unknown>;
    comp.currency = cleanEnds(comp.currency);
    comp.interval = cleanEnds(comp.interval);
    out.compensation = comp;
  }

  return out as unknown as JobPostDto;
}
