import { SitemapEntry } from './types';

/** Minimal HTTP surface needed (an `HttpClient` satisfies it). */
export interface SitemapHttp {
  get<T = any>(url: string, config?: any): Promise<{ data: T; status?: number; headers?: any }>;
}

/**
 * Parse a `<urlset>` or `<sitemapindex>` document (entities, CDATA, namespaces).
 * Spec 1691 — implemented by lane B5.
 */
export function parseSitemapXml(xml: string): { urls: SitemapEntry[]; sitemaps: SitemapEntry[] } {
  throw new Error('not implemented (Spec 1691 lane B5)');
}

/** Accepts ISO 8601 and `YYYY-MM-DD[ HH:MM:SS]`; undefined when invalid. */
export function parseLastmod(raw: string | undefined): Date | undefined {
  throw new Error('not implemented (Spec 1691 lane B5)');
}

/**
 * Fetch a sitemap (following `<sitemapindex>` up to `maxDepth`, `.gz` supported)
 * and return its `<url>` entries, newest `lastmod` first when `sortByLastmod`.
 */
export function fetchSitemap(
  http: SitemapHttp,
  url: string,
  options?: {
    maxUrls?: number;
    maxDepth?: number;
    maxSitemaps?: number;
    filter?: (loc: string) => boolean;
    sortByLastmod?: boolean;
  },
): Promise<SitemapEntry[]> {
  throw new Error('not implemented (Spec 1691 lane B5)');
}
