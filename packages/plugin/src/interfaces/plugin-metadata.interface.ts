import { Site, SiteCategory } from '@ever-jobs/models';

/**
 * Metadata describing a source plugin.
 * Attached via the @SourcePlugin() decorator.
 */
export interface IPluginMetadata {
  /** The Site enum value this plugin handles */
  site: Site;

  /** Human-readable name for display and logging */
  name: string;

  /**
   * Category of the source plugin.
   * Used for filtering, grouping, and documentation.
   */
  category: PluginCategory;

  /**
   * Whether this is an ATS (Applicant Tracking System) source
   * that requires a companySlug to target a specific company board.
   * @default false
   */
  isAts?: boolean;

  /**
   * Company domains this plugin serves, e.g. `['stokespace.com']` (Spec 5086).
   *
   * A caller can address a company plugin by domain (`companyDomain`), which is
   * otherwise resolved by deriving a token from the domain (Spec 5069). Plugins
   * named after something else — an ATS board slug, say — are unreachable that
   * way, so they declare their domains here and the registry indexes them.
   *
   * An array because one plugin can serve several hosts: an acquired company
   * whose domain still resolves, a rebrand, a marketing domain distinct from the
   * corporate one. Values may be bare hosts or full URLs; they are normalized on
   * registration.
   */
  companyDomains?: string[];

  /**
   * The source cannot list anything without a keyword (Spec 1720) — e.g. it
   * puts the term in the URL path. In list mode (no `searchTerm`) the
   * orchestrator does not dispatch it and reports an `empty` diagnostic
   * instead of sending a malformed request.
   * @default false
   */
  requiresSearchTerm?: boolean;

  /**
   * Optional description of the plugin's capabilities or limitations.
   */
  description?: string;
}

/**
 * Category of a source plugin. Alias of `SiteCategory` in `@ever-jobs/models`
 * (Spec 1720), which is the single list the search API validates
 * `siteCategories` against.
 */
export type PluginCategory = SiteCategory;
