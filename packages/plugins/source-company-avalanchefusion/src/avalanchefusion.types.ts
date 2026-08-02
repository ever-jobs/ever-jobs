import { CompensationInterval } from '@ever-jobs/models';

/** A role link enumerated from the open-positions board. */
export interface AvalanchefusionOpening {
  /** Collection slug (last path segment). */
  slug: string;
  /** Absolute role page URL (jobUrl). */
  jobUrl: string;
  /** Role title from the listing card. */
  title: string;
}

/** Fields parsed from a role's detail page. */
export interface AvalanchefusionDetail {
  /** Role title from the detail heading (falls back to the listing title). */
  title: string | null;
  /** Rendered rich-text description (markdown). */
  description: string | null;
  /** Raw "Salary Range" text, e.g. `$135K/yr - $175K/yr`. */
  salaryText: string | null;
  /** External apply URL (a LinkedIn job posting). */
  applyUrl: string | null;
}

/** A pay range plus its authoritative interval read from the pay token. */
export interface AvalanchefusionPay {
  text: string | null;
  interval: CompensationInterval | undefined;
}
