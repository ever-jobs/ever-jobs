import {
  JobType,
  CompensationInterval,
  LocationDto,
  getCompensationInterval,
  getJobTypeFromString,
} from '@ever-jobs/models';
import { parseLocationText } from '@ever-jobs/common';
import {
  INDEED_JOB_TYPE_ATTRIBUTE_KEYS,
  INDEED_LEGACY_JOB_TYPE_KEY_PREFIX,
  INDEED_LEGACY_REMOTE_ATTRIBUTE_KEY,
  INDEED_REMOTE_ATTRIBUTE_KEY,
  IndeedMappingOptions,
} from './indeed.constants';

/** One entry of `job.attributes`: an opaque code plus its display label. */
export interface IndeedAttribute {
  key?: string | null;
  label?: string | null;
}

/** `job.location` as the search document requests it. */
export interface IndeedLocation {
  city?: string | null;
  state?: string | null;
  country?: string | null;
  countryCode?: string | null;
  postalCode?: string | null;
  formatted?: { long?: string | null; short?: string | null } | null;
}

/** The parts of a `jobSearch` job this module reads. */
export interface IndeedJob {
  attributes?: IndeedAttribute[] | null;
  location?: IndeedLocation | null;
}

export type IndeedWorkFromHomeType = 'Remote' | 'Hybrid';

export interface IndeedWorkplace {
  isRemote: boolean;
  /** `'Remote'`, `'Hybrid'`, or `null` when nothing says so (on-site or unknown). */
  workFromHomeType: IndeedWorkFromHomeType | null;
}

const KEY_TO_JOB_TYPE: ReadonlyMap<string, JobType> = new Map(
  (Object.entries(INDEED_JOB_TYPE_ATTRIBUTE_KEYS) as [JobType, string][]).map(
    ([jobType, key]) => [key, jobType],
  ),
);

// Whole-label and label-head rules. The attribute list also carries skills and
// benefits ("Remote desktop support", "Remote sensing"), so a label only counts
// when the WHOLE label is a workplace word, and the formatted location only
// counts by its head ("Remote in Austin, TX"). The description and the title
// are never read: they say "no remote work" on on-site jobs.
const REMOTE_LABEL_RE =
  /^(?:(?:temporarily|fully|100%)\s+remote|remote|work[\s-]+from[\s-]+home|wfh)$/i;
const HYBRID_LABEL_RE = /^hybrid(?:\s+(?:work|remote))?$/i;
const REMOTE_LOCATION_RE = /^(?:temporarily\s+)?remote\b/i;
const HYBRID_LOCATION_RE = /^hybrid\b/i;

/** "Remote in ", "Hybrid work in " ... ahead of the real place in a formatted label. */
const WORKPLACE_HEAD_RE = /^(?:(?:temporarily\s+)?remote|hybrid(?:\s+(?:work|remote))?)\s+in\s+/i;
/** A trailing US ZIP after the state ("Austin, TX 78701"). Runs on whitespace-collapsed text. */
const TRAILING_ZIP_RE = /^(.*,[^,]*\S) (\d{5}(?:-\d{4})?)$/;
/** Formatted labels are a few words; anything longer is not parsed for a ZIP. */
const MAX_FORMATTED_LABEL_LENGTH = 200;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

function attributesOf(attributes: IndeedAttribute[] | null | undefined): IndeedAttribute[] {
  return Array.isArray(attributes) ? attributes.filter((a) => a && typeof a === 'object') : [];
}

function formattedLabel(location: IndeedLocation | null | undefined): string | null {
  return text(location?.formatted?.long) ?? text(location?.formatted?.short);
}

/**
 * Get job types from Indeed attribute list.
 *
 * Spec 1702: attribute keys are opaque codes (`CF3CP` = Full-time), so a key
 * resolves through {@link INDEED_JOB_TYPE_ATTRIBUTE_KEYS}, and any other
 * attribute resolves only when its WHOLE label is a job-type alias ("Temporary",
 * "Permanent"); "Contract management" does not. Keys starting with `job-types`
 * (the only rule before) still resolve. `{ attributeMapping: false }` restores
 * the pre-1702 rule alone.
 */
export function getJobType(
  attributes: IndeedAttribute[] | null | undefined,
  options: IndeedMappingOptions = {},
): JobType[] | null {
  if (!attributes) return null;
  const types: JobType[] = [];

  if (options.attributeMapping === false) {
    for (const attr of attributesOf(attributes)) {
      if (typeof attr.key === 'string' && attr.key.startsWith(INDEED_LEGACY_JOB_TYPE_KEY_PREFIX)) {
        const jt = getJobTypeFromString(attr.label);
        if (jt) types.push(jt);
      }
    }
    return types.length > 0 ? types : null;
  }

  for (const attr of attributesOf(attributes)) {
    const key = typeof attr.key === 'string' ? attr.key.trim() : '';
    const jt = KEY_TO_JOB_TYPE.get(key) ?? getJobTypeFromString(text(attr.label));
    if (jt && !types.includes(jt)) types.push(jt);
  }
  return types.length > 0 ? types : null;
}

/**
 * Extract compensation from Indeed API data.
 */
export function getCompensation(compensation: any): {
  interval: CompensationInterval | null;
  minAmount: number | null;
  maxAmount: number | null;
  currency: string | null;
} | null {
  if (!compensation) return null;

  const currencyCode = compensation.currencyCode ?? 'USD';

  // Try base salary first, then estimated
  const baseSalary = compensation.baseSalary ?? compensation.estimated?.baseSalary;
  if (!baseSalary) return null;

  const range = baseSalary.range;
  if (!range) return null;

  const interval = baseSalary.unitOfWork
    ? getCompensationInterval(baseSalary.unitOfWork)
    : null;

  return {
    interval,
    minAmount: range.min ?? null,
    maxAmount: range.max ?? null,
    currency: currencyCode,
  };
}

/**
 * Remote or hybrid, from the job's workplace attribute and the head of its
 * formatted location only (Spec 1702). An explicit Remote signal (the Remote
 * attribute code, a whole "Remote" label or a "Remote in ..." location) wins
 * over a hybrid one. The description and the title are never read.
 *
 * `{ attributeMapping: false }` restores the pre-1702 rule: remote only when an
 * attribute key is `remotejob`, and never a `workFromHomeType`.
 */
export function detectWorkplace(
  job: IndeedJob | null | undefined,
  options: IndeedMappingOptions = {},
): IndeedWorkplace {
  const attributes = attributesOf(job?.attributes);

  if (options.attributeMapping === false) {
    return {
      isRemote: attributes.some((attr) => attr.key === INDEED_LEGACY_REMOTE_ATTRIBUTE_KEY),
      workFromHomeType: null,
    };
  }

  const place = formattedLabel(job?.location) ?? '';
  const remote =
    attributes.some((attr) => {
      if (attr.key === INDEED_REMOTE_ATTRIBUTE_KEY || attr.key === INDEED_LEGACY_REMOTE_ATTRIBUTE_KEY) {
        return true;
      }
      const label = text(attr.label);
      return label !== null && REMOTE_LABEL_RE.test(label);
    }) || REMOTE_LOCATION_RE.test(place);
  if (remote) return { isRemote: true, workFromHomeType: 'Remote' };

  const hybrid =
    attributes.some((attr) => {
      const label = text(attr.label);
      return label !== null && HYBRID_LABEL_RE.test(label);
    }) || HYBRID_LOCATION_RE.test(place);
  if (hybrid) return { isRemote: false, workFromHomeType: 'Hybrid' };

  return { isRemote: false, workFromHomeType: null };
}

/**
 * Determine if an Indeed job is remote from attributes.
 *
 * Kept for source compatibility: the attribute part of {@link detectWorkplace}.
 * `{ attributeMapping: false }` gives the pre-1702 `key === 'remotejob'` check.
 */
export function isJobRemote(
  attributes: IndeedAttribute[] | null | undefined,
  options: IndeedMappingOptions = {},
): boolean {
  if (!attributes) return false;
  return detectWorkplace({ attributes }, options).isRemote;
}

/**
 * Parse a formatted label ("Remote in Austin, TX 78701") when the job carries
 * no structured geography. The workplace head is dropped first, so the city
 * never reads "Remote in Austin", and a trailing US ZIP goes to `postalCode`
 * rather than the site name. A bare "Remote" goes to the shared parser as is,
 * which keeps its process-wide remote-city convention.
 */
function parseFormattedLabel(label: string): {
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  name: string | null;
} {
  const place = label.replace(WORKPLACE_HEAD_RE, '').trim();
  let rest = place === '' ? label : place;
  let postalCode: string | null = null;
  const zip = rest.length <= MAX_FORMATTED_LABEL_LENGTH ? TRAILING_ZIP_RE.exec(rest) : null;
  if (zip) {
    rest = zip[1].trim();
    postalCode = zip[2];
  }
  const parsed = parseLocationText(rest).location;
  const country = parsed?.country;
  return {
    city: text(parsed?.city),
    state: text(parsed?.state),
    country: typeof country === 'string' ? text(country) : null,
    postalCode: postalCode ?? text(parsed?.postalCode),
    name: text(parsed?.name),
  };
}

/**
 * The job's location. Structured fields come first; `formatted.long` is kept
 * verbatim in `text` and is only parsed for geography when the job has no
 * city, state or country at all (Spec 1702).
 *
 * `{ formattedLocation: false }` restores the pre-1702 `{ city, state, country }`.
 */
export function buildLocation(
  location: IndeedLocation | null | undefined,
  options: IndeedMappingOptions = {},
): LocationDto {
  const loc = location ?? {};

  if (options.formattedLocation === false) {
    return new LocationDto({
      city: loc.city ?? null,
      state: loc.state ?? null,
      country: loc.country ?? null,
    });
  }

  const city = text(loc.city);
  const state = text(loc.state);
  const country = text(loc.country);
  const countryCode = text(loc.countryCode);
  const postalCode = text(loc.postalCode);
  const label = formattedLabel(loc);

  if (city || state || country || !label) {
    return new LocationDto({
      city,
      state,
      country: country ?? countryCode,
      ...(postalCode ? { postalCode } : {}),
      ...(label ? { text: label } : {}),
    });
  }

  const parsed = parseFormattedLabel(label);
  const zip = postalCode ?? parsed.postalCode;
  return new LocationDto({
    city: parsed.city,
    state: parsed.state,
    country: parsed.country ?? countryCode,
    ...(parsed.name ? { name: parsed.name } : {}),
    ...(zip ? { postalCode: zip } : {}),
    text: label,
  });
}
