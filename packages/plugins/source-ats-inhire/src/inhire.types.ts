/**
 * Wire and internal types for the InHire public job-posts API (Spec 1692).
 *
 * Only the fields the adapter reads are modelled. Every wire field is optional
 * and typed `unknown`-friendly, because the adapter narrows each one at parse
 * time: a tenant or a future shape change must never break the parser.
 */

/** The career page a lean-list row belongs to. `name` is the tenant slug, not the brand. */
export interface InhireCareerPageRef {
  id?: string | null;
  name?: string | null;
  careerPage?: string | null;
}

/** One row of `GET /job-posts/public/pages/lean`. */
export interface InhireListItem {
  /** Stable ATS id (UUID). */
  jobId?: string | null;
  /** Title; about one row in five carries trailing spaces. */
  displayName?: string | null;
  /** Career page of the tenant the role is published on (e.g. `default`). */
  careerPageId?: string | null;
  careerPage?: InhireCareerPageRef | null;
  /** Candidate-facing job page, normally `https://{tenant}.inhire.com.br/vagas/{jobId}`. */
  link?: string | null;
}

/** `GET /job-posts/public/pages/{jobId}`: one role's full record. */
export interface InhireJobDetail {
  jobId?: string | null;
  displayName?: string | null;
  /** Only `published` roles are emitted. */
  status?: string | null;
  /** Display company name (e.g. `Olist`). */
  tenantName?: string | null;
  /** Company blurb, HTML. */
  about?: string | null;
  /** Company logo URL. */
  logo?: string | null;
  /** Banner image URLs; the first https entry is used. */
  background?: unknown;
  /** Job body, HTML with named entities (`miss&atilde;o`). */
  description?: string | null;
  /** Brazilian contract labels, e.g. `["CLT"]`. */
  contractType?: unknown;
  /** `Remote`, `Hybrid` or `On-site`. */
  workplaceType?: string | null;
  /** An ISO-3166 alpha-2 code (`BR`) or free text such as a city. */
  location?: string | null;
  /** Optional extra location text, e.g. a state code. */
  locationComplement?: string | null;
  publishedAt?: string | null;
  createdAt?: string | null;
  lastPublishedAt?: string | null;
  updatedAt?: string | null;
}

/** A cleaned, de-duplicated lean-list row, in list order. */
export interface InhireCandidate {
  /** Position in the cleaned list (orders the final result). */
  index: number;
  /** Validated UUID, as the API sent it. */
  jobId: string;
  /** Trimmed, whitespace-collapsed title. */
  title: string;
  /** Raw `link` from the row, pinned later. */
  link: string | null;
}

/** The location label handed to the shared parser, plus the ISO code when known. */
export interface InhireLocationLabel {
  label: string | null;
  countryCode: string | null;
}

/** Why a candidate did not become a job. */
export type InhireSkipReason = 'status' | 'removed' | 'failed' | 'mismatch' | 'untitled';

/** Counters behind the per-scrape summary log line. */
export interface InhireScrapeStats {
  listed: number;
  truncated: number;
  invalid: number;
  dupe: number;
  candidates: number;
  detailTried: number;
  detailOk: number;
  skippedStatus: number;
  removed: number;
  failed: number;
  filteredOut: number;
  unfetched: number;
}
