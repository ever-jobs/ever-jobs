/**
 * Source categories a plugin can declare in its `@SourcePlugin({ category })`
 * metadata (Spec 1720).
 *
 * This is the single source of truth: `PluginCategory` in `@ever-jobs/plugin`
 * is an alias of {@link SiteCategory}, and `ScraperInputDto.siteCategories`
 * validates against {@link SITE_CATEGORIES}. Adding a category means adding it
 * here — the DTO validation, the plugin decorator type and the OpenAPI enum
 * all follow.
 */
export const SITE_CATEGORIES = [
  'job-board',
  'niche',
  'regional',
  'remote',
  'government',
  'freelance',
  'company',
  'ats',
] as const;

/** One of {@link SITE_CATEGORIES}. */
export type SiteCategory = (typeof SITE_CATEGORIES)[number];

/** Type guard for {@link SiteCategory}. Case-sensitive, like the metadata. */
export function isSiteCategory(value: unknown): value is SiteCategory {
  return (
    typeof value === 'string' &&
    (SITE_CATEGORIES as readonly string[]).includes(value)
  );
}
