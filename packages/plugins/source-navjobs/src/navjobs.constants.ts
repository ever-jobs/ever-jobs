export const NAVJOBS_FEED_URL = 'https://pam-stilling-feed.nav.no/api/v1/feed';
export const NAVJOBS_PUBLIC_TOKEN_URL = 'https://pam-stilling-feed.nav.no/api/publicToken';
export const NAVJOBS_DEFAULT_RESULTS = 25;
/**
 * Auth-token fetch budget, in SECONDS -- createHttpClient multiplies by 1000.
 * Spelled out in the name because the option itself is unit-ambiguous.
 */
export const NAVJOBS_TOKEN_TIMEOUT_SECONDS = 10;

export const NAVJOBS_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent': 'EverJobs/1.0',
};

/**
 * Public page of a NAV job ad on arbeidsplassen.nav.no, keyed by the feed
 * entry's `uuid` (Spec 1751). The feed item's own `url` is the API resource
 * (`/api/v1/feedentry/<uuid>`) and must never become a link.
 */
export const NAVJOBS_PUBLIC_AD_URL = 'https://arbeidsplassen.nav.no/stillinger/stilling';
