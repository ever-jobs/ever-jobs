import { z } from 'zod';
import { Site } from '../enums/site.enum';

/**
 * Zod boundary schema for {@link FieldWithProvenance}.
 * Used by the dedup engine when ingesting cross-process payloads.
 */
export const FieldWithProvenanceSchema = z.object({
  value: z.unknown(),
  _source: z.nativeEnum(Site),
  _sourceId: z.string().min(1),
  _observedAt: z.string().datetime({ offset: true }),
});

export type FieldWithProvenanceShape = z.infer<typeof FieldWithProvenanceSchema>;

/**
 * Zod boundary schema for {@link SourceObservation}.
 */
export const SourceObservationSchema = z.object({
  site: z.nativeEnum(Site),
  sourceJobId: z.string().min(1),
  url: z.string().url(),
  observedAt: z.string().datetime({ offset: true }),
  rawTitle: z.string().min(1).optional(),
});

export type SourceObservationShape = z.infer<typeof SourceObservationSchema>;

/**
 * Zod boundary schema for {@link CanonicalJob}.
 * `parse(...)` round-trips the production `CanonicalJob` shape; `safeParse`
 * is preferred at hot paths to avoid throws.
 */
const LocationShapeSchema = z.object({
  name: z.string().nullable().optional(),
  text: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  streetAddress: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
});

export const CanonicalJobSchema = z.object({
  canonicalJobId: z.string().regex(/^[a-f0-9]{64}$/, 'must be a sha-256 hex digest'),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string(),
  /** Union of observations' per-site locations (Spec 5123). */
  locations: z.array(LocationShapeSchema).optional(),
  /** Union of observations' tagged offices (Spec 5123). */
  offices: z
    .array(
      LocationShapeSchema.extend({ id: z.string().nullable().optional() }),
    )
    .optional(),
  /** ATS-declared ISO-3166 alpha-2 posting country, verbatim (Spec 1689). */
  countryCode: z.string().min(1).optional(),
  description: z.string().optional(),
  url: z.string().url(),
  sources: z.array(SourceObservationSchema).min(1),
  fields: z.record(z.string(), FieldWithProvenanceSchema),
  mergedAt: z.string().datetime({ offset: true }),
});

export type CanonicalJobShape = z.infer<typeof CanonicalJobSchema>;

/**
 * Minimal "RawJob" boundary — what the dedup engine accepts as input.
 * Mirrors the writeable subset of `JobPostDto` plus mandatory provenance.
 *
 * We don't reuse `JobPostDto` here because that DTO is intentionally loose
 * (most fields nullable) for plugin-author ergonomics; `RawJobSchema` is
 * tighter so dedup can trust the inputs.
 */
export const RawJobSchema = z.object({
  site: z.nativeEnum(Site),
  sourceJobId: z.string().min(1),
  title: z.string().min(1),
  companyName: z.string().min(1),
  jobUrl: z.string().url(),
  location: z
    .object({
      name: z.string().nullable().optional(),
      text: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      streetAddress: z.string().nullable().optional(),
      postalCode: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  /** Per-site locations; `location` stays the merged compat view. */
  locations: z
    .array(
      z.object({
        name: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
        city: z.string().nullable().optional(),
        state: z.string().nullable().optional(),
        country: z.string().nullable().optional(),
        streetAddress: z.string().nullable().optional(),
        postalCode: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  /** Company offices tagged on the posting (e.g. Greenhouse `offices[]`) —
   *  catalog entities, not necessarily role-sites. */
  offices: z
    .array(
      z.object({
        id: z.string().nullable().optional(),
        name: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
        city: z.string().nullable().optional(),
        state: z.string().nullable().optional(),
        country: z.string().nullable().optional(),
        streetAddress: z.string().nullable().optional(),
        postalCode: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  /** ATS-declared ISO-3166 alpha-2 posting country, verbatim (Spec 1689). */
  countryCode: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  observedAt: z.string().datetime({ offset: true }).optional(),
});

export type RawJobShape = z.infer<typeof RawJobSchema>;
