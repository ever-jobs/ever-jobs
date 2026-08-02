/**
 * Every public notion.site page is backed by the same unauthenticated JSON API
 * on www.notion.so; `loadPageChunk` returns a block recordMap addressable by
 * page id alone (no per-tenant subdomain needed). This is the whole ingest
 * substrate the plugin stands on.
 */
export const NOTION_API_URL = 'https://www.notion.so/api/v3/loadPageChunk';

export const NOTION_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
  accept: 'application/json',
};

/** Blocks pulled per chunk. Career boards are small; one chunk covers them. */
export const NOTION_CHUNK_LIMIT = 100;

/** Bounded fan-out when fetching each role sub-page's blocks. */
export const NOTION_DETAIL_CONCURRENCY = 5;

/** Default result cap when the caller doesn't specify `resultsWanted`. */
export const NOTION_DEFAULT_RESULTS = 100;

/**
 * The labelled meta line most Notion job pages open with, e.g.
 * `Location: Los Angeles, CA (On-Site)`. Convention, not a Notion standard, so
 * treated as a best-effort hint — its absence never drops a role.
 */
export const NOTION_LOCATION_LABEL = /^\s*location\s*:\s*(.+)$/im;
