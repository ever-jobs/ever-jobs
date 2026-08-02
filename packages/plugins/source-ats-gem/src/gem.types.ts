/**
 * Spec 006 / T05 — Gem GraphQL response shapes.
 *
 * Subset of the upstream Python `JobPosting` / `Location` /
 * `Department` / `Job` dataclasses, narrowed to the fields we
 * actually map onto `JobPostDto`. Keeping the shapes structural
 * (interfaces, no class) means a fixture stub in the unit test
 * doesn't need to instantiate any of them — the parser is happy as
 * long as the JSON shape matches. Field names are PascalCase'd to
 * match the GraphQL response wire shape verbatim.
 */

/** Shape of a single location entry inside a `GemJobPosting.locations[]`. */
export interface GemLocation {
  readonly id?: string;
  readonly name?: string;
  readonly city?: string;
  readonly isoCountry?: string;
  readonly isRemote?: boolean;
  readonly extId?: string;
}

/** Shape of `GemJobPosting.job.department`. */
export interface GemDepartment {
  readonly id?: string;
  readonly name?: string;
  readonly extId?: string;
}

/** Shape of `GemJobPosting.job` — wraps department / location-type / employment-type metadata. */
export interface GemJobMeta {
  readonly id?: string;
  readonly department?: GemDepartment | null;
  readonly locationType?: string;
  readonly employmentType?: string;
}

/** Single posting in `data.oatsExternalJobPostings.jobPostings[]`. */
export interface GemJobPosting {
  readonly id?: string;
  readonly extId?: string;
  readonly title?: string;
  readonly locations?: ReadonlyArray<GemLocation>;
  readonly job?: GemJobMeta;
}

/**
 * The `data` payload carried by the array element whose operation
 * is `JobBoardList`. Both the array order in the wire response AND
 * which element actually carries the postings can vary, so the
 * parser checks `data.oatsExternalJobPostings` is defined before
 * trusting the entry.
 */
export interface GemJobBoardListData {
  readonly oatsExternalJobPostings?: {
    readonly jobPostings?: ReadonlyArray<GemJobPosting>;
  };
  readonly jobBoardExternal?: {
    readonly id?: string;
    readonly teamDisplayName?: string;
  };
}

/**
 * Single response envelope (one entry per operation in the
 * batched POST). The server may include `errors` even when
 * `data` is partially populated — we treat any envelope with a
 * non-empty `errors` array AND no `data.oatsExternalJobPostings`
 * as a failed list operation.
 */
export interface GemBatchEnvelope {
  readonly data?: GemJobBoardListData & Record<string, unknown>;
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
}

/**
 * `data.oatsExternalJobPosting` from the per-posting
 * `ExternalJobPostingQuery` detail op. Carries the fields the list
 * op omits: the full body, the posted-date timestamps, and the
 * free-text pay block.
 */
export interface GemExternalJobPosting {
  readonly descriptionHtml?: string | null;
  /** First-published Unix timestamp in **seconds**. */
  readonly firstPublishedTsSec?: number | null;
  /** Fallback posted-date timestamp (seconds) when `firstPublishedTsSec` is absent. */
  readonly startDateTs?: number | null;
  readonly compensationHtml?: string | null;
}

/** Response envelope for the batched detail POST (one `ExternalJobPostingQuery` op). */
export interface GemDetailEnvelope {
  readonly data?: {
    readonly oatsExternalJobPosting?: GemExternalJobPosting | null;
  };
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
}
