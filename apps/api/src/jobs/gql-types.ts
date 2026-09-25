import { ObjectType, Field, InputType, Int, Float, ID, registerEnumType } from '@nestjs/graphql';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, MaxLength,
} from 'class-validator';
import {
  COUNTRY_CONFIG, Country, ExclusionPreset, Site, getIndeedDomain,
  HARD_MAX_SEARCH_LOCATIONS, MAX_EXCLUSION_TERMS, MAX_EXCLUSION_TERM_LENGTH, MAX_SEARCH_LOCATION_LENGTH,
} from '@ever-jobs/models';

// ── Register the Site enum for GraphQL ───────────────────
registerEnumType(Site, {
  name: 'Site',
  description: 'Supported job board / ATS / company source',
});

// ── Register the ExclusionPreset enum for GraphQL (Spec 1700) ──
registerEnumType(ExclusionPreset, {
  name: 'ExclusionPreset',
  description: 'Curated exclusion lists matched against title + description',
});

// ── Input Types ──────────────────────────────────────────

/**
 * GraphQL search input.
 *
 * 🛑 Every field carries a class-validator decorator (Spec 1689). The API
 * installs a global `ValidationPipe({ whitelist: true })` (apps/api/src/main.ts),
 * and Nest runs global pipes on resolver `@Args` too. Whitelisting strips every
 * property that has no class-validator metadata, so without these decorators
 * the resolver received an EMPTY input — no search term, no source filter —
 * and every GraphQL search shared one cache key. The decorators mirror the
 * GraphQL types, so nothing the schema accepts is rejected.
 */
@InputType()
export class SearchJobsInput {
  @Field(() => [Site], { nullable: true, description: 'Sources to search (omit for all)' })
  @IsOptional()
  @IsArray()
  @IsEnum(Site, { each: true })
  siteType?: Site[];

  @Field({ description: 'Search term / keywords' })
  @IsString()
  searchTerm!: string;

  @Field({ nullable: true, description: 'Location filter (city, state, country)' })
  @IsOptional()
  @IsString()
  location?: string;

  @Field(() => [String], {
    nullable: true,
    description:
      `Several locations searched in one request (Spec 1700): every source runs once per location, one after another, ` +
      `each with its own resultsWanted; exact same-source duplicates are removed. \`location\`, when also set, is ` +
      `searched first. At most ${HARD_MAX_SEARCH_LOCATIONS} entries; the server searches the first ` +
      `EVER_JOBS_SEARCH_MAX_LOCATIONS (default 10).`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(HARD_MAX_SEARCH_LOCATIONS)
  @IsString({ each: true })
  @MaxLength(MAX_SEARCH_LOCATION_LENGTH, { each: true })
  locations?: string[];

  @Field(() => Int, { nullable: true, defaultValue: 20, description: 'Number of results wanted per source' })
  @IsOptional()
  @IsInt()
  resultsWanted?: number;

  @Field({
    nullable: true,
    description:
      'Country for country-scoped sources (Indeed, Glassdoor, …): a Country enum value (USA, UK, GERMANY), a country name or alias (United States, germany), or an ISO 3166 alpha-2 code (US, GB, DE). An unrecognised value is ignored.',
  })
  @IsOptional()
  @IsString()
  country?: string;

  @Field(() => Int, { nullable: true, description: 'Search radius in miles' })
  @IsOptional()
  @IsInt()
  distance?: number;

  @Field({ nullable: true, description: 'Company slug for ATS sources' })
  @IsOptional()
  @IsString()
  companySlug?: string;

  @Field({ nullable: true, defaultValue: 'markdown', description: 'Description format: markdown, html, or text' })
  @IsOptional()
  @IsString()
  descriptionFormat?: string;

  @Field({
    nullable: true,
    defaultValue: true,
    description:
      'Cross-source deduplication. Default true — collapses identical or near-duplicate jobs surfaced by multiple sources into one record. Pass false to keep every observation as a separate result (Spec 003 / FR-1).',
  })
  @IsOptional()
  @IsBoolean()
  dedup?: boolean;

  @Field(() => [String], {
    nullable: true,
    description:
      'Drop jobs whose TITLE contains any of these words or phrases (Spec 1700): case- and accent-insensitive, ' +
      'whole-word, trailing * = prefix, literal text (never a regex), negated mentions ignored. Applied after dedup.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EXCLUSION_TERMS)
  @IsString({ each: true })
  @MaxLength(MAX_EXCLUSION_TERM_LENGTH, { each: true })
  excludeTitleTerms?: string[];

  @Field(() => [String], {
    nullable: true,
    description: 'Drop jobs whose TITLE or DESCRIPTION contains any of these words or phrases (Spec 1700).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EXCLUSION_TERMS)
  @IsString({ each: true })
  @MaxLength(MAX_EXCLUSION_TERM_LENGTH, { each: true })
  excludeKeywords?: string[];

  @Field(() => [ExclusionPreset], {
    nullable: true,
    description: 'Curated exclusion lists matched against title + description (Spec 1700).',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(ExclusionPreset, { each: true })
  excludePresets?: ExclusionPreset[];
}

/** ISO alpha-2 -> Country, from each country's Indeed API code (first wins). */
const COUNTRY_BY_ALPHA2: ReadonlyMap<string, Country> = (() => {
  const map = new Map<string, Country>();
  for (const country of Object.values(Country)) {
    const code = getIndeedDomain(country).apiCountryCode;
    if (/^[A-Z]{2}$/.test(code) && !map.has(code)) map.set(code, country);
  }
  return map;
})();

/**
 * Map the GraphQL `country` string to a `Country` (Spec 1689). The REST DTO
 * takes `@IsEnum(Country)`; GraphQL has always documented codes such as
 * 'DE', which is not an enum value, and a raw 'DE' reaching a source made
 * `getIndeedDomain('DE')` throw. Accepts, in order: an enum value
 * ('GERMANY', case-insensitive), a COUNTRY_CONFIG name or alias
 * ('united states', 'uk'), an ISO alpha-2 code ('DE', 'GB'). Returns
 * `undefined` for anything else — the caller drops it.
 */
export function resolveSearchCountry(value: string | null | undefined): Country | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const upper = trimmed.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(COUNTRY_CONFIG, upper)) {
    return upper as Country;
  }
  const lower = trimmed.toLowerCase();
  for (const country of Object.keys(COUNTRY_CONFIG) as Country[]) {
    if (COUNTRY_CONFIG[country].names.split(',').includes(lower)) return country;
  }
  return COUNTRY_BY_ALPHA2.get(upper);
}

// ── Output Types ─────────────────────────────────────────

@ObjectType()
export class LocationGql {
  @Field({ nullable: true })
  country?: string;

  @Field({ nullable: true })
  city?: string;

  @Field({ nullable: true })
  state?: string;

  // Spec 1689 — the richer LocationDto fields (Spec 5123), additive and
  // nullable so existing `location { city state country }` queries are unchanged.
  @Field(() => String, {
    nullable: true,
    description: "The source's own label for the site (e.g. \"Downtown Office\"). Not geography.",
  })
  name?: string | null;

  @Field(() => String, {
    nullable: true,
    // Spec 1689 — describes what the shared parser actually emits: the
    // per-site segment ('US' for 'Remote - US'), often absent, rarely the
    // whole raw label. See docs/questions.md for the open parser cases.
    description:
      'The label text this site was read from, when it differs from the structured city/state/country: for most sources the per-site segment after list splitting and qualifier stripping (e.g. "US" for "Remote - US"), not the full raw label. Often null.',
  })
  text?: string | null;

  @Field(() => String, { nullable: true, description: 'Street address, when the source carries one.' })
  streetAddress?: string | null;

  @Field(() => String, { nullable: true, description: 'Postal / ZIP code, when the source carries one.' })
  postalCode?: string | null;
}

@ObjectType({
  description:
    'A company office the source tags on the posting (e.g. Greenhouse offices[]). A catalog entity — not necessarily where the role sits.',
})
export class OfficeGql extends LocationGql {
  @Field(() => String, { nullable: true, description: "The source's own office identifier." })
  id?: string | null;
}

@ObjectType()
export class CompensationGql {
  @Field(() => Float, { nullable: true })
  minAmount?: number;

  @Field(() => Float, { nullable: true })
  maxAmount?: number;

  @Field({ nullable: true })
  currency?: string;

  @Field({ nullable: true })
  interval?: string;
}

@ObjectType()
export class JobPostGql {
  @Field(() => ID, { nullable: true })
  id?: string;

  @Field({ nullable: true })
  site?: string;

  @Field({ nullable: true })
  title?: string;

  @Field({ nullable: true })
  companyName?: string;

  @Field({ nullable: true })
  jobUrl?: string;

  @Field(() => LocationGql, { nullable: true })
  location?: LocationGql;

  // Spec 1689 — per-site data and the ATS posting country (Specs 5118/5123),
  // additive and nullable.
  @Field(() => [LocationGql], {
    nullable: true,
    description:
      'Per-site locations when the source carries them. `location` stays the merged single-site view.',
  })
  locations?: LocationGql[] | null;

  @Field(() => [OfficeGql], {
    nullable: true,
    description: 'Company offices the source tags on the posting (not necessarily the role sites).',
  })
  offices?: OfficeGql[] | null;

  @Field(() => String, {
    nullable: true,
    description: 'ISO-3166 alpha-2 country the ATS declared for the posting (e.g. "NL"), verbatim.',
  })
  countryCode?: string | null;

  @Field({ nullable: true })
  description?: string;

  @Field(() => [String], { nullable: true })
  jobType?: string[];

  @Field(() => CompensationGql, { nullable: true })
  compensation?: CompensationGql;

  @Field({ nullable: true })
  datePosted?: string;

  @Field(() => [String], { nullable: true })
  emails?: string[];

  @Field({ nullable: true })
  isRemote?: boolean;

  @Field({ nullable: true })
  companyUrl?: string;

  @Field({ nullable: true })
  logoUrl?: string;
}

@ObjectType({
  description:
    'Per-call dedup metrics — populated only when the dedup engine actually ran (Spec 003 / FR-3).',
})
export class DedupMetricsGql {
  @Field(() => Int, { description: 'Number of raw jobs fed into the engine.' })
  inputCount!: number;

  @Field(() => Int, { description: 'Number of canonical clusters emitted.' })
  outputCount!: number;

  @Field(() => Int, {
    description: 'Number of raw-pair merges performed across all stages.',
  })
  mergedPairs!: number;

  @Field(() => Float, {
    description: 'Wall-clock cost of the dedup pass, in milliseconds.',
  })
  elapsedMs!: number;
}

@ObjectType({ description: 'Matching rows per exclusion term (Spec 1700).' })
export class ExclusionTermCountGql {
  @Field()
  term!: string;

  @Field({ description: '`title_terms`, `keywords` or `preset:<name>`.' })
  source!: string;

  @Field(() => Int)
  count!: number;
}

@ObjectType({ description: 'An exclusion term that compiled to nothing and was ignored (Spec 1700).' })
export class IgnoredExclusionTermGql {
  @Field()
  term!: string;

  @Field({
    description: 'empty, too_long, too_many_tokens, prefix_too_short, over_limit or unknown_preset.',
  })
  reason!: string;
}

@ObjectType({
  description:
    'Exclusion filter outcome (Spec 1700) — populated only when an exclusion field was supplied.',
})
export class ExclusionMetricsGql {
  @Field(() => Int, { description: 'Results removed from the final list (whole clusters when dedup ran).' })
  excludedCount!: number;

  @Field(() => Int, { description: 'Raw observations that matched, before dedup.' })
  excludedRawCount!: number;

  @Field(() => [ExclusionTermCountGql])
  byTerm!: ExclusionTermCountGql[];

  @Field(() => [IgnoredExclusionTermGql])
  ignoredTerms!: IgnoredExclusionTermGql[];
}

@ObjectType()
export class SearchJobsResult {
  @Field(() => Int, { description: 'Number of jobs in the response (post-dedup when applicable).' })
  count!: number;

  @Field(() => [JobPostGql])
  jobs!: JobPostGql[];

  @Field()
  cached!: boolean;

  @Field({
    description:
      'True iff the dedup engine actually ran. False when no engine is bound or the caller passed dedup: false.',
  })
  deduped!: boolean;

  @Field(() => Int, {
    description: 'Pre-dedup count. Equals raw fan-out length.',
  })
  rawCount!: number;

  @Field(() => DedupMetricsGql, {
    nullable: true,
    description: 'Populated only when deduped=true.',
  })
  dedupMetrics?: DedupMetricsGql;

  @Field(() => ExclusionMetricsGql, {
    nullable: true,
    description: 'Populated only when an exclusion field was supplied (Spec 1700). `count` is post-exclusion.',
  })
  exclusionMetrics?: ExclusionMetricsGql;
}

@ObjectType()
export class SiteSourceGql {
  @Field()
  name!: string;

  @Field()
  value!: string;
}

@ObjectType()
export class SourceListResult {
  @Field(() => Int)
  total!: number;

  @Field(() => [SiteSourceGql])
  sources!: SiteSourceGql[];
}
