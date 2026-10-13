/**
 * TypeScript interfaces for the Recruitly public careers surface.
 *
 * Recruitly tenant boards expose their published roles through a public, anonymous JSON
 * endpoint (`https://api.recruitly.io/api/job?apiKey={apiKey}`) that answers a
 * `{ "data": [ … ] }` envelope. The adapter reads `data` as the role array. The interfaces
 * below describe the subset of that wire shape the adapter reads plus the normalised
 * internal role assembled from it. Everything the adapter reads is optional and
 * defensively narrowed at parse time, so cross-tenant or future-shape drift never breaks
 * the parser.
 */

import { LocationDto } from '@ever-jobs/models';

/**
 * The structured location embedded in a role. Recruitly roles carry a single structured
 * address rather than a free-text location line.
 */
export interface RecruitlyLocation {
  /** Street / address line, when present. */
  addressLine?: string | null;
  /** City name (e.g. `London`). */
  cityName?: string | null;
  /** Region / county / state name (e.g. `Greater London`). */
  regionName?: string | null;
  /** Post / ZIP code, when present. */
  postCode?: string | null;
  /** ISO country code (e.g. `GB`). */
  countryCode?: string | null;
  /** Full country name (e.g. `United Kingdom`). */
  countryName?: string | null;
  /** Latitude, when geocoded. */
  latitude?: number | null;
  /** Longitude, when geocoded. */
  longitude?: number | null;
}

/** A currency / tenure reference object embedded in a role's `pay` block. */
export interface RecruitlyRef {
  /** Internal id. */
  id?: number | string | null;
  /** Short code (e.g. `USD`, `MONTH`). */
  code?: string | null;
  /** Display name. */
  name?: string | null;
  /** Display symbol (currency only, e.g. `$`). */
  symbol?: string | null;
}

/**
 * A role's pay block: structured currency / tenure / min-max plus a pre-formatted
 * `jobPayLabel` Recruitly renders on the board (e.g. `USD100 Per Month`).
 */
export interface RecruitlyPay {
  /** Pay currency reference. */
  currency?: RecruitlyRef | null;
  /** Pay tenure reference (e.g. per hour / month / annum). */
  tenure?: RecruitlyRef | null;
  /** Minimum pay value. */
  minPay?: number | null;
  /** Maximum pay value. */
  maxPay?: number | null;
  /** True when the pay is a min-max range. */
  range?: boolean | null;
  /** Pre-formatted pay label (e.g. `USD100 Per Month`). */
  jobPayLabel?: string | null;
}

/**
 * A single published role as embedded in the public feed envelope at `data[]`. Only the
 * fields the adapter consumes are modelled; all are optional and defensively narrowed.
 */
export interface RecruitlyJobItem {
  /** `hire…`-prefixed string id — the stable ATS id and the final apply-URL segment. */
  id?: string | null;
  /** Numeric internal id (alternate stable id). */
  uniqueId?: number | string | null;
  /** Agency role reference (e.g. `JB-3842`). */
  reference?: string | null;
  /** Role display title. */
  title?: string | null;
  /** Role lifecycle status (`OPEN` / `CLOSED`). */
  status?: string | null;
  /** Job type token (e.g. `Contract`, `Permanent`), when present. */
  jobType?: string | null;
  /** Employment type token, when present. */
  employmentType?: string | null;
  /** True when the role advertises remote / home-working. */
  remoteWorking?: boolean | null;
  /** Hiring brand / company the agency is recruiting for. */
  companyName?: string | null;
  /** Structured location for the role. */
  location?: RecruitlyLocation | null;
  /** Structured pay block. */
  pay?: RecruitlyPay | null;
  /** Posted date (`DD/MM/YYYY`). */
  postedOn?: string | null;
  /** ISO / display application-deadline date, when present. */
  estClosingDate?: string | null;
  /** HTML role description body. */
  description?: string | null;
  /** Public apply-widget URL (`https://jobs.recruitly.io/widget/apply/{id}`). */
  applyUrl?: string | null;
}

/**
 * The top-level public-feed envelope. The adapter narrows `data` to an array of roles.
 * Some deployments wrap the list under `data`, others answer a bare array — the adapter
 * narrows both.
 */
export interface RecruitlyJobFeed {
  /** The published roles for the tenant board. */
  data?: RecruitlyJobItem[] | null;
}

/**
 * Normalised view of a single Recruitly role, ready to map to a JobPostDto.
 */
export interface RecruitlyJob {
  /** Stable ATS id (the role `id`, else `uniqueId`, else `reference`). */
  atsId: string;

  /** Absolute public apply / detail URL (the apply-widget page). */
  url: string;

  /** Absolute public apply URL (the apply-widget page). */
  applyUrl: string;

  /** Job display title. */
  title?: string | null;

  /** Hiring company / brand display name. */
  companyName?: string | null;

  /** Structured location parts derived from the role's location. */
  city?: string | null;
  state?: string | null;
  country?: string | null;

  /** Full mapped location DTO (recovers postalCode, streetAddress, extras). */
  locationDto?: LocationDto | null;

  /** Combined free-text location, used for remote detection. */
  locationText?: string | null;

  /** Role description body (HTML), when the feed exposes one, else null. */
  descriptionHtml?: string | null;

  /** Employment type token (jobType / employmentType). */
  employmentType?: string | null;

  /** Posted date — parsed from `postedOn`, when available. */
  datePosted?: string | null;

  /** True when the role advertises remote / home-working. */
  isRemote?: boolean | null;
}
