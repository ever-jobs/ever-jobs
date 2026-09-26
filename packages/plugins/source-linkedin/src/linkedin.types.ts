import type { PostedTime } from '@ever-jobs/common';
import type { CompensationDto, JobPostDto, JobType, ScraperInputDto } from '@ever-jobs/models';

/** How precise an applicant count is: "154 applicants", "Over 200", "Be among the first 25". */
export type ApplicantsBound = 'exact' | 'min' | 'max';

export interface ApplicantsInfo {
  count: number;
  bound: ApplicantsBound;
}

/**
 * Fields Spec 1701 adds to a LinkedIn job. They are declared on the shared
 * `JobPostDto` too; this type keeps the plugin's own contract explicit. They
 * are only set when there is a value.
 */
export interface LinkedInJobExtras {
  /** LinkedIn's numeric company id (`meta[name=companyId]`); reusable as the `f_C` filter. */
  companySourceId?: string | null;
  /** Applicant count shown on the posting. */
  applicantsCount?: number | null;
  /** How `applicantsCount` bounds the real number. */
  applicantsCountBound?: ApplicantsBound | null;
}

export type LinkedInJobPost = JobPostDto & LinkedInJobExtras;

/** Scraper input as this plugin reads it: `linkedinFetchCompanyDetails` is optional and additive. */
export type LinkedInScraperInput = ScraperInputDto & {
  /** Fetch each company page once (cached, capped) to fill website, size, HQ, industry, description and logo. */
  linkedinFetchCompanyDetails?: boolean;
};

/** One guest search card, parsed but not yet mapped to a `JobPostDto`. */
export interface LinkedInCard {
  /** Numeric posting id from `data-entity-urn`, else the trailing digits of the href. */
  jobId: string | null;
  /** The card link as served (slug URL with tracking query), entities decoded. */
  href: string | null;
  title: string;
  companyName: string | null;
  /** The company link as served (may carry `?trk=` and a regional subdomain). */
  companyHref: string | null;
  /** A `media.licdn.com` logo URL, never a placeholder. */
  companyLogo: string | null;
  locationText: string;
  /** `<time datetime>` value (`YYYY-MM-DD`). */
  timeDatetime: string | null;
  /** `<time>` text, e.g. "26 minutes ago" (whitespace collapsed). */
  timeText: string | null;
  /** `.job-search-card__salary-info` text, whitespace collapsed. */
  salaryText: string | null;
}

/** A parsed search page. `cardCount` counts every card, parseable or not, for the `start` step. */
export interface LinkedInSearchPage {
  cardCount: number;
  cards: LinkedInCard[];
}

/** What a job view page adds to a card. Every field is independently optional. */
export interface LinkedInJobDetail {
  /** Converted per `descriptionFormat`; `null` when the page has no description block. */
  description: string | null;
  jobLevel: string | null;
  jobType: JobType[] | null;
  jobFunction: string | null;
  companyIndustry: string | null;
  companySourceId: string | null;
  applicants: ApplicantsInfo | null;
  compensation: CompensationDto | null;
  jobUrlDirect: string | null;
  companyLogo: string | null;
  /** From the page's JobPosting JSON-LD `datePosted`, when present. */
  posted: PostedTime;
}

/** What a public company page yields. */
export interface LinkedInCompanyDetails {
  website: string | null;
  address: string | null;
  /** `numberOfEmployees.value`: LinkedIn's member count, not the size band. */
  employeesLd: string | null;
  /** The "Company size" band without the trailing " employees", e.g. `1,001-5,000`. */
  sizeBand: string | null;
  industry: string | null;
  description: string | null;
  logo: string | null;
}

/** Per-area switches back to pre-Spec 1701 behaviour (`EVER_JOBS_LINKEDIN_LEGACY`). */
export interface LinkedInLegacyFlags {
  /** `start += 25` and stop on the first page with no new id. */
  pagination: boolean;
  /** `li-<url-slug>` ids, slug job URLs and company URLs as served. */
  ids: boolean;
  /** The old card pay regex (USD only, no detail pay block). */
  pay: boolean;
  /** The old description selector and job type read from every criterion. */
  detail: boolean;
  /** The old substring remote test, with no stamping from `isRemote`. */
  remote: boolean;
}
