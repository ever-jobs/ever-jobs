import type { PluginCrawlPolicy } from '@ever-jobs/common';
import { Site } from '@ever-jobs/models';

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
   * Smallest gap, milliseconds, the plugin keeps between two requests to its
   * host (Spec 1700). A plugin paces requests only inside one `scrape()` call,
   * so the first request of the next call is unpaced; a multi-location search
   * calls a source once per location and waits at least this long between
   * those calls. Unset means only the operator's location interval applies.
   *
   * Not a crawl-policy field: the per-host limiter paces every request from
   * `crawl.minIntervalMs` (below) and the layers around it (Spec 1690). This
   * one only spaces a multi-location search's calls to the source.
   */
  minRequestIntervalMs?: number;

  /**
   * Optional description of the plugin's capabilities or limitations.
   */
  description?: string;

  /**
   * How this source should be crawled (Spec 1690): pacing, identity, proxy
   * rotation, retries, discovery. These are the plugin's *defaults* — operators
   * (`EVER_JOBS_CRAWL_POLICIES`) and search callers (`crawl`) can override them.
   * A plugin that sets `userAgentMode: 'plugin'` must explain why in
   * `userAgentReason` (e.g. the API requires a registered e-mail as its UA).
   *
   * @example { rateLimitScope: 'domain', maxConcurrentPerHost: 1, minIntervalMs: 1000 }
   */
  crawl?: PluginCrawlPolicy;
}

export type PluginCategory =
  | 'job-board'
  | 'ats'
  | 'company'
  | 'niche'
  | 'government'
  | 'remote'
  | 'regional'
  | 'freelance';
