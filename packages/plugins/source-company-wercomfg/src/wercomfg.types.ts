import type { JobPostingLd } from '@ever-jobs/common';

/** A detail-page link collected from the careers index. */
export interface WercoDetailLink {
  url: string;
  slug: string;
}

/** Normalised JSON-LD posting plus the raw extras the node carries. */
export interface WercoPosting {
  posting: JobPostingLd;
  identifier: string | null;
  industry: string | null;
  occupationalCategory: string | null;
  workHours: string | null;
}
