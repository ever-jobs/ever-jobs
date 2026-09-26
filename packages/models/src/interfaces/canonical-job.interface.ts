import { LocationDto } from '../dtos/location.dto';
import { OfficeDto } from '../dtos/office.dto';
import { FieldWithProvenance } from './field-with-provenance.interface';
import { SourceObservation } from './source-observation.interface';

/**
 * A deduplicated, source-merged job posting.
 *
 * Produced by the dedup engine (Spec 003). One `CanonicalJob` represents one
 * logical role even if N different sources surfaced it. The flat top-level
 * fields (`title`, `company`, `location`, ...) hold the resolver-elected
 * "best" values; `fields` carries every field with provenance for callers
 * that need to inspect how the merge happened.
 */
export interface CanonicalJob {
  /**
   * sha-256(normCompany | normTitle | siteSet). Stable across runs.
   * `siteSet` is the sorted set of normalised `city|state|country` triples
   * from `locations[]`, falling back to the flattened `location` string
   * when a source carries no per-site data (Spec 5123).
   */
  readonly canonicalJobId: string;

  // Flat shortcuts — duplicated from `fields` for ergonomic access.
  readonly title: string;
  readonly company: string;
  /** Merged display scalar; `locations` is the richer per-site source when
   *  present, this field is the fallback for sources without per-site data. */
  readonly location: string;

  /** Union of every observation's `locations[]`, deduped on
   *  `city|state|country` (entries without geography dedupe on `name|text`).
   *  Absent when no observation carried per-site data. */
  readonly locations?: ReadonlyArray<LocationDto>;

  /** Union of every observation's `offices[]`, deduped on `id` then
   *  `name|text`. Absent when no observation carried offices. */
  readonly offices?: ReadonlyArray<OfficeDto>;

  /** ISO-3166 alpha-2 country an ATS declared for the posting (e.g. "NL"),
   *  verbatim from `JobPostDto.countryCode` — the head observation's when it
   *  has one, else the first observation's that does (Spec 1689). Posting-level
   *  metadata, not the parsed country of `location`. Absent when no
   *  observation carried one. */
  readonly countryCode?: string;
  readonly description?: string;
  /** The "primary" URL — picked by the merge resolver from `sources[].url`. */
  readonly url: string;

  /** Every observation that contributed to this canonical record. */
  readonly sources: ReadonlyArray<SourceObservation>;

  /**
   * Per-field winning value with full provenance. Includes at least
   * `title`, `company`, `location`, `url`, plus any plugin-specific fields
   * the resolver decided to surface (e.g. `compensation`, `jobType`).
   */
  readonly fields: Readonly<Record<string, FieldWithProvenance<unknown>>>;

  /** ISO-8601 timestamp of the dedup pass that produced this record. */
  readonly mergedAt: string;
}
