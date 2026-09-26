/**
 * TypeScript interfaces for the Welcome to the Jungle (WTTJ) public careers surface.
 *
 * WTTJ company jobs pages (`welcometothejungle.com/{lang}/companies/{slug}/jobs`) are
 * powered by a public, anonymous Algolia search index. The adapter queries that index
 * directly (`POST …/indexes/{index}/query` with a `facetFilters` of
 * `["organization.slug:{slug}"]`) and maps each returned hit. The interfaces below
 * describe the subset of the Algolia hit wire shape the adapter reads plus the
 * normalised internal role assembled from it. Everything the adapter reads is optional
 * and defensively narrowed at parse time, so cross-company or future-shape drift never
 * breaks the parser.
 */

import {
  CompensationDto,
  DatePostedBasis,
  DatePostedPrecision,
  JobType,
  LocationDto,
} from '@ever-jobs/models';

/**
 * A single structured office (workplace) attached to a job hit. WTTJ splits a role's
 * location into one or more offices, each carrying city / state / country parts.
 */
export interface WttjOffice {
  /** City label (e.g. `Auxerre`). */
  city?: string | null;
  /** State / region label (e.g. `Bourgogne-Franche-Comte`). */
  state?: string | null;
  /** Country label (e.g. `France`). */
  country?: string | null;
  /** ISO country code (e.g. `FR`). */
  country_code?: string | null;
  /** Administrative district, when present. */
  district?: string | null;
}

/**
 * The role's profession classification, as embedded in an Algolia hit (`new_profession`).
 * Only the human-readable category / sub-category labels are consumed.
 */
export interface WttjProfession {
  /** Top-level category label (e.g. `Business & Finance`). */
  category_name?: string | null;
  /** Sub-category label (e.g. `Executive`). */
  sub_category_name?: string | null;
  /** Free-text pivot / role label (e.g. `Sector Manager`). */
  pivot_name?: string | null;
}

/**
 * The company ("organization") embedded in each job hit. Carries its own stable slug
 * (used to build canonical URLs + as the facet-filter key) and display name.
 */
export interface WttjOrganization {
  /** URL-safe company slug — the `{org.slug}` segment of the canonical detail URL. */
  slug?: string | null;
  /** Company display name (the real brand name — preferred over the de-slugified slug). */
  name?: string | null;
  /** Internal company reference id. */
  reference?: string | null;
  /** Company logo (Spec 1705 B5: `companyLogo`). */
  logo?: { url?: string | null } | null;
  /** Headcount (Spec 1705 B5: `companyNumEmployees`). */
  nb_employees?: number | null;
  /** One-line company pitch (Spec 1705 B5: `companyDescription`). */
  summary?: string | null;
}

/** A sector tag attached to a job hit (Spec 1705 B5: `companyIndustry`). */
export interface WttjSector {
  /** Sector label (e.g. `SaaS / Cloud Services`). */
  name?: string | null;
  /** Parent sector label (e.g. `Tech`). */
  parent_name?: string | null;
}

/**
 * A single job as returned by the WTTJ Algolia index. Only the fields the adapter
 * consumes are modelled; all are optional and defensively narrowed.
 */
export interface WttjJobHit {
  /** Algolia object id — equals `reference` (the stable per-role guid). */
  objectID?: string | null;
  /** Stable per-role reference guid — the ATS id. */
  reference?: string | null;
  /** Job title. */
  name?: string | null;
  /** URL-safe per-role slug — the `{job.slug}` segment of the canonical detail URL. */
  slug?: string | null;
  /** Contract type token (e.g. `full_time`, `internship`, `apprenticeship`). */
  contract_type?: string | null;
  /** Structured workplace offices (city / state / country parts). */
  offices?: WttjOffice[] | null;
  /** Remote-work token (e.g. `no`, `fulltime`, `partial`, `punctual`). */
  remote?: string | null;
  /** Profession classification (category / sub-category / pivot labels). */
  new_profession?: WttjProfession | null;
  /** Short teaser / summary of the role (plain-ish text). */
  summary?: string | null;
  /** Candidate-profile section of the ad body (HTML-ish), when present. */
  profile?: string | null;
  /**
   * Key missions of the role. The live index sends a list of plain-text sentences; a
   * single string is still accepted (Spec 1705 B2).
   */
  key_missions?: string[] | string | null;
  /** ISO publish timestamp (e.g. `2026-06-03T19:01:03Z`). */
  published_at?: string | null;
  /** Alternate publish date string, when present. */
  published_at_date?: string | null;
  /** Language of the listing (e.g. `fr`, `en`). */
  language?: string | null;
  /** Embedded company ("organization") object. */
  organization?: WttjOrganization | null;

  // Spec 1705 B7: structured fields the index carries on every hit.

  /** Lower salary bound, in `salary_period` units. */
  salary_minimum?: number | null;
  /** Upper salary bound, in `salary_period` units. */
  salary_maximum?: number | null;
  /** Yearly-equivalent lower bound. */
  salary_yearly_minimum?: number | null;
  /** ISO 4217 currency of the salary fields (e.g. `EUR`). */
  salary_currency?: string | null;
  /** Pay period of `salary_minimum` / `salary_maximum` (e.g. `yearly`, `monthly`). */
  salary_period?: string | null;
  /** True when `salary_yearly_minimum` is set. */
  has_salary_yearly_minimum?: boolean | null;
  /** Publish time as epoch seconds. */
  published_at_timestamp?: number | null;
  /** Minimum experience, in years. */
  experience_level_minimum?: number | null;
  /** True when `experience_level_minimum` is meaningful. */
  has_experience_level_minimum?: boolean | null;
  /** Education token (e.g. `bac_5`, `no_diploma`). */
  education_level?: string | null;
  /** Sector tags. */
  sectors?: WttjSector[] | null;
  /** Benefit labels. */
  benefits?: string[] | null;
  /** Office coordinates. */
  _geoloc?: { lat: number; lng: number }[] | null;
  /** Contract duration bounds, in months. */
  contract_duration_minimum?: number | null;
  contract_duration_maximum?: number | null;
  /** True when the posting states a remote policy. */
  has_remote?: boolean | null;
  /** The site's own short posting reference (e.g. `ACME_Ab12Cd3`). */
  wk_reference?: string | null;
}

/**
 * The Algolia query response envelope. Modelled defensively — the adapter narrows
 * `hits` to an array and reads the pagination counters when present.
 */
export interface WttjAlgoliaResponse {
  /** The page of job hits. */
  hits?: WttjJobHit[] | null;
  /** Total number of matching hits across all pages. */
  nbHits?: number | null;
  /** Total number of pages. */
  nbPages?: number | null;
  /** Zero-based current page index. */
  page?: number | null;
  /** Page size used. */
  hitsPerPage?: number | null;
  /** Informational or error message (e.g. the 1,000-hit window notice, a refused key). */
  message?: string | null;
}

/**
 * Normalised view of a single WTTJ role, ready to map to a JobPostDto.
 */
export interface WttjJob {
  /** Stable ATS id (the hit `reference`, falling back to `objectID`). */
  atsId: string;

  /** Absolute public detail URL (the canonical company-jobs detail page). */
  url: string;

  /** Absolute public apply URL. */
  applyUrl: string;

  /** Job display title. */
  title?: string | null;

  /** Company display name (the embedded brand name, falling back to the de-slugified slug). */
  companyName?: string | null;

  /** Structured location parts derived from the first office. */
  city?: string | null;
  state?: string | null;
  country?: string | null;

  /** HTML / text job-ad body (assembled from the available section fragments), when present. */
  descriptionHtml?: string | null;

  /** Department / profession label. */
  department?: string | null;

  /** Normalised employment-type label, when derivable. */
  employmentType?: string | null;

  /** Posted date — parsed from `published_at`, when available. */
  datePosted?: string | null;

  /** True when the role advertises remote / home-working. */
  isRemote?: boolean | null;

  // Spec 1705 B: fields mapped from the structured hit.

  /** Canonical job types derived from `contract_type`. */
  jobType?: JobType[] | null;
  /** Structured salary, else the salary parsed from the description. */
  compensation?: CompensationDto | null;
  /** `Remote` or `Hybrid` when the remote policy says so. */
  workFromHomeType?: string | null;
  /** ISO 3166-1 alpha-2 code of the primary office. */
  countryCode?: string | null;
  /** One location per office. */
  locations?: LocationDto[] | null;
  /** Company logo URL. */
  companyLogo?: string | null;
  /** Sector labels, comma-joined. */
  companyIndustry?: string | null;
  /** Headcount, as a string. */
  companyNumEmployees?: string | null;
  /** Company pitch. */
  companyDescription?: string | null;
  /** Profession category. */
  jobFunction?: string | null;
  /** Minimum experience label (e.g. `5+ years`). */
  experienceRange?: string | null;
  /** Posting instant and its precision (Spec 1696), when consistent with `datePosted`. */
  datePostedAt?: string | null;
  datePostedPrecision?: DatePostedPrecision | null;
  datePostedBasis?: DatePostedBasis | null;
}
