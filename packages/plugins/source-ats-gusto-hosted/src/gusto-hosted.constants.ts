/**
 * Constants for the Gusto-hosted job-board platform.
 *
 * Gusto (the payroll/HR vendor) runs a multi-tenant job-board product at
 * `https://jobs.gusto.com`. Each tenant company has:
 *
 *   Board  : GET /boards/{slug}            -> lists the tenant's postings, each
 *                                             linked as /postings/{postingSlug}.
 *   Posting: GET /postings/{postingSlug}   -> a single role; embeds a schema.org
 *                                             `JobPosting` JSON-LD block
 *                                             (title, description, datePosted,
 *                                             hiringOrganization, location,
 *                                             baseSalary).
 *
 * IMPORTANT — this is NOT `source-company-gusto`. That plugin scrapes Gusto,
 * Inc.'s OWN corporate careers (a single employer, Greenhouse-backed). This
 * plugin scrapes the per-tenant boards Gusto HOSTS for other companies. The two
 * share the vendor name but are different targets; see Spec 5054.
 *
 * Both pages sit behind a Cloudflare managed challenge, so they are loaded with
 * the shared stealth headless browser (`BrowserPool`), the same approach as
 * `source-company-desktopmetal` — a real browser clears the challenge.
 */

/** Origin of the Gusto-hosted board product. */
export const GUSTO_HOSTED_ORIGIN = 'https://jobs.gusto.com';

/** Default results cap when the caller omits `resultsWanted`. */
export const GUSTO_HOSTED_DEFAULT_RESULTS = 100;

/** Hard ceiling on posting-detail fan-out per scrape. */
export const GUSTO_HOSTED_MAX_DETAIL_FETCHES = 100;

/** Bounded concurrency for posting-detail fan-out (browser pages are heavy). */
export const GUSTO_HOSTED_DETAIL_CONCURRENCY = 4;

/**
 * Per-navigation timeout (seconds). Higher than a plain HTTP default because a
 * real browser must clear the Cloudflare challenge before the board renders.
 */
export const GUSTO_HOSTED_DEFAULT_TIMEOUT_SECONDS = 30;

/** Builds the tenant board URL from the board slug (`<company>-<uuid>`). */
export const gustoHostedBoardUrl = (slug: string): string =>
  `${GUSTO_HOSTED_ORIGIN}/boards/${encodeURIComponent(slug)}`;

/** Builds a posting detail URL from the posting slug. */
export const gustoHostedPostingUrl = (postingSlug: string): string =>
  `${GUSTO_HOSTED_ORIGIN}/postings/${encodeURIComponent(postingSlug)}`;

/** Matches `/postings/{postingSlug}` links on the board (absolute or relative). */
export const GUSTO_HOSTED_POSTING_LINK_RE = /\/postings\/([^/?#"']+)/i;

/** CSS selector the board renders once postings are present (browser readiness). */
export const GUSTO_HOSTED_BOARD_READY_SELECTOR = 'a[href*="/postings/"]';

/**
 * Trailing UUID on a board/posting slug (`…-8-4-4-4-12`). Stripped to recover a
 * human company/title token for display when JSON-LD is unavailable.
 */
export const GUSTO_HOSTED_UUID_SUFFIX_RE =
  /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Detects remote / home-working roles from the title or location text. */
export const GUSTO_HOSTED_REMOTE_REGEX =
  /\b(remote|virtual|home[\s-]?(?:based|working|office)|work\s*from\s*home|wfh|telecommute|telework|anywhere)\b/i;
