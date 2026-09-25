/**
 * Constants for the Wellfound company-board (ATS-mode) scraper.
 *
 * Some employers use Wellfound as their only board: their careers page links
 * out to `wellfound.com/company/{slug}/jobs`, and the postings exist only
 * there. That is a board-enumeration problem — the `source-wellfound` plugin
 * is an aggregator *search* scraper and cannot guarantee board coverage.
 *
 * wellfound.com sits behind Cloudflare and answers plain HTTP with a
 * challenge page, so fetching goes through the headless browser pool. The
 * server-rendered `#__NEXT_DATA__` carries a normalized Apollo cache under
 * `props.pageProps.apolloState.data`: every posting is a `JobListing:{id}`
 * node, the employer is a `Startup:{id}` node. Board pages accept `?page=N`
 * (~20 listings per page, per the connection's `first:20` argument).
 */

export const WELLFOUND_ATS_HOST = 'wellfound.com';

export const WELLFOUND_ATS_DEFAULT_TIMEOUT_SECONDS = 30;

/** Safety cap on `?page=N` iterations; a runaway board cannot loop forever. */
export const WELLFOUND_ATS_MAX_PAGES = 50;

/** Hydration settle time before reading `__NEXT_DATA__`. */
export const WELLFOUND_ATS_HYDRATE_MS = 6000;
