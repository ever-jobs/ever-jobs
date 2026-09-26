import { JobType } from '@ever-jobs/models';

export const INDEED_HEADERS: Record<string, string> = {
  Host: 'apis.indeed.com',
  accept: 'application/json',
  'indeed-api-key': '161092c2017b5bbab13edb12461a62d5a833871e7c7571571571de7161a3b1d3',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'content-type': 'application/json',
};

export const JOB_SEARCH_QUERY = `
query GetJobData($what: String, $location: String, $cursor: String, $dateOnSiteFrom: DateInput, $radius: Int, $fromAge: String, $seoFriendlyToken: String, $filters: [SearchFilterInput!]) {
  jobSearch(
    what: $what
    location: { where: $location, radius: $radius, radiusUnit: MILES }
    cursor: $cursor
    sort: DATE
    limit: 100
    dateOnSiteFrom: $dateOnSiteFrom
    fromage: $fromAge
    seoFriendlyToken: $seoFriendlyToken
    filters: $filters
  ) {
    pageInfo { nextCursor }
    results {
      trackingKey
      job {
        source { name }
        key
        title
        dateOnSite
        datePublished
        description { html }
        location { formatted { long } city state country countryCode postalCode }
        attributes { label key }
        compensation { baseSalary { unitOfWork range { ... on Range { min max } } } estimated { baseSalary { unitOfWork range { ... on Range { min max } } } } formattedRange currencyCode }
        employer { dpiUrl name companyProfile { pageUrl images { squareLogoUrl bannerUrl } description overview { revenue employeeCount industryName } locations } relatedJobs(limit: 0) { totalCount } }
      }
    }
  }
}`;

// -- Attribute keys (Spec 1702) ----------------------------------------------
// `attributes[].key` is an opaque 5-character code, not a word. These are the
// codes the public search filters use; `attributes[].label` carries the words.

/** Workplace attribute "Remote" (the public site's Remote filter is `attr(DSQF7)`). */
export const INDEED_REMOTE_ATTRIBUTE_KEY = 'DSQF7';

/** The key the pre-1702 mapping compared against. Never a real code; still honoured. */
export const INDEED_LEGACY_REMOTE_ATTRIBUTE_KEY = 'remotejob';

/** The key prefix the pre-1702 job-type mapping looked for. Still honoured. */
export const INDEED_LEGACY_JOB_TYPE_KEY_PREFIX = 'job-types';

/** Employment-type attribute codes. Types without a code resolve from the label. */
export const INDEED_JOB_TYPE_ATTRIBUTE_KEYS: Readonly<Partial<Record<JobType, string>>> = Object.freeze({
  [JobType.FULL_TIME]: 'CF3CP',
  [JobType.PART_TIME]: '75GKK',
  [JobType.CONTRACT]: 'NJXCK',
  [JobType.INTERNSHIP]: 'VDTG7',
});

// -- Behaviour switches (Spec 1702) ------------------------------------------
// Each is read on every scrape, so it can be flipped without a rebuild. Unset
// or unrecognised means ON; `false`, `0`, `no` or `off` restores the pre-1702
// behaviour.

/**
 * ON: `isRemote` / `workFromHomeType` come from the Remote attribute code, a
 * whole workplace label ("Remote", "Hybrid work") or the head of
 * `location.formatted.long` ("Remote in Austin, TX"), and `jobType` from the
 * employment-type codes plus whole-label aliases. OFF: the pre-1702 mapping
 * (`key === 'remotejob'`, keys starting with `job-types`, no `workFromHomeType`).
 */
export const INDEED_ATTRIBUTE_MAPPING_ENV = 'EVER_JOBS_INDEED_ATTRIBUTE_MAPPING';

/**
 * ON: the location also carries `text` (the formatted label verbatim),
 * `postalCode`, a `countryCode` fallback for `country`, and, when the job has
 * no structured city/state/country, whatever can be parsed from the formatted
 * label. OFF: the pre-1702 `{ city, state, country }`.
 */
export const INDEED_FORMATTED_LOCATION_ENV = 'EVER_JOBS_INDEED_FORMATTED_LOCATION';

/**
 * Most search pages fetched per scrape. Unset or invalid: {@link INDEED_DEFAULT_MAX_PAGES}.
 * `0`, `off`, `none` or `unlimited` removes the cap (pre-1702: paging stopped
 * only at `resultsWanted` or the last page).
 */
export const INDEED_MAX_PAGES_ENV = 'EVER_JOBS_INDEED_MAX_PAGES';

/** 10 pages of up to 100 results each. */
export const INDEED_DEFAULT_MAX_PAGES = 10;

const SWITCH_OFF_VALUES: ReadonlySet<string> = new Set(['false', '0', 'no', 'off']);
const NO_PAGE_CAP_VALUES: ReadonlySet<string> = new Set(['0', 'off', 'none', 'unlimited']);

function readSwitch(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return true;
  return !SWITCH_OFF_VALUES.has(raw);
}

/** How a job is mapped. Every field defaults to ON when omitted. */
export interface IndeedMappingOptions {
  /** See {@link INDEED_ATTRIBUTE_MAPPING_ENV}. */
  attributeMapping?: boolean;
  /** See {@link INDEED_FORMATTED_LOCATION_ENV}. */
  formattedLocation?: boolean;
}

/** Read both mapping switches from the environment. */
export function readIndeedMappingOptions(
  env: NodeJS.ProcessEnv = process.env,
): Required<IndeedMappingOptions> {
  return {
    attributeMapping: readSwitch(env, INDEED_ATTRIBUTE_MAPPING_ENV),
    formattedLocation: readSwitch(env, INDEED_FORMATTED_LOCATION_ENV),
  };
}

/** Read {@link INDEED_MAX_PAGES_ENV}. `0` means no cap. */
export function readIndeedMaxPages(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[INDEED_MAX_PAGES_ENV]?.trim().toLowerCase();
  if (!raw) return INDEED_DEFAULT_MAX_PAGES;
  if (NO_PAGE_CAP_VALUES.has(raw)) return 0;
  if (!/^\d{1,6}$/.test(raw)) return INDEED_DEFAULT_MAX_PAGES;
  const pages = Number(raw);
  return pages > 0 ? pages : INDEED_DEFAULT_MAX_PAGES;
}
