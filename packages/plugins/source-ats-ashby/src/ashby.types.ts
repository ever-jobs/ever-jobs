/**
 * TypeScript interfaces for Ashby API responses.
 * Ported from ats-scrapers/models/ashby.py
 */

export interface AshbyAddress {
  postalAddress?: {
    addressLocality?: string | null;
    addressRegion?: string | null;
    addressCountry?: string | null;
  } | null;
}

export interface AshbyCompensationTier {
  title?: string | null;
  tierFloor?: number | null;
  tierCeiling?: number | null;
  currency?: string | null;
  tierType?: string | null;
  interval?: string | null;
}

export interface AshbyCompensationComponent {
  compensationType?: string | null;
  tiers?: AshbyCompensationTier[] | null;
  label?: string | null;
}

/**
 * Flat compensation component served by the public job-board API when
 * `includeCompensation=true` is passed (live wire shape, probed 2026-06-11).
 * Appears inside `summaryComponents[]` and `compensationTiers[].components[]`.
 */
export interface AshbyFlatCompensationComponent {
  id?: string | null;
  summary?: string | null;
  compensationType?: string | null;
  /** e.g. "1 YEAR", "1 HOUR", "NONE" */
  interval?: string | null;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
}

/** A tier group on the public wire: a label plus flat components. */
export interface AshbyCompensationTierGroup {
  id?: string | null;
  tierSummary?: string | null;
  title?: string | null;
  additionalInformation?: string | null;
  components?: AshbyFlatCompensationComponent[] | null;
}

export interface AshbyCompensation {
  compensationComponents?: AshbyCompensationComponent[] | null;
  summaryComponents?:
    | Array<AshbyCompensationComponent & AshbyFlatCompensationComponent>
    | null;
  /** Public wire shape (with includeCompensation=true). */
  compensationTiers?: AshbyCompensationTierGroup[] | null;
  compensationTierSummary?: string | null;
  scrapeableCompensationSalarySummary?: string | null;
}

export interface AshbyJob {
  id?: string | null;
  title?: string | null;
  /** Public job-board name. */
  department?: string | null;
  /** Authenticated Posting API name. */
  departmentName?: string | null;
  /** Public job-board name. */
  team?: string | null;
  /** Authenticated Posting API name. */
  teamName?: string | null;
  employmentType?: string | null;
  location?: string | null;
  address?: AshbyAddress | null;
  secondaryLocations?: Array<{
    location?: string | null;
    address?: AshbyAddress | null;
  }> | null;
  isRemote?: boolean | null;
  /** Structured workplace signal: `OnSite` | `Hybrid` | `Remote`. */
  workplaceType?: string | null;
  /** Public job-board name (ISO timestamp). */
  publishedAt?: string | null;
  /** Authenticated Posting API name. */
  publishedDate?: string | null;
  descriptionHtml?: string | null;
  descriptionPlain?: string | null;
  jobUrl?: string | null;
  applyUrl?: string | null;
  compensation?: AshbyCompensation | null;
  isListed?: boolean | null;
}

export interface AshbyResponse {
  jobs: AshbyJob[];
  apiVersion?: string;
}
