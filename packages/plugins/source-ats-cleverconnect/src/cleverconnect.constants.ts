/**
 * Constants for the CleverConnect career-site platform.
 *
 * CleverConnect (cleverconnect.com, France) is a talent-acquisition vendor whose
 * candidate-facing product is a hosted, branded "Career Site". Every customer tenant
 * publishes a public, unauthenticated career board on its own sub-domain of the
 * shared career-site host, addressed by a tenant label:
 *
 *   https://career.{tenant}.cleverconnect.com/jobs        (candidate-facing board)
 *
 * The board is an Angular single-page application, but the server pre-renders the
 * full open-roles payload into the initial HTML document as an Angular
 * **TransferState** hydration blob (a JSON island whose double-quotes are
 * HTML-entity-encoded as `&q;`, ampersands as `&a;`, `<`/`>` as `&l;`/`&g;`, single
 * quotes as `&s;`). Decoding that blob yields a JSON array of fully-structured offer
 * objects — so the adapter never needs the SPA's runtime XHR API (which is not a
 * stable public surface), it just decodes and parses the embedded payload.
 *
 * Each embedded offer object carries (all fields optional / defensively narrowed):
 *   - `id`            CleverConnect offer id (string of digits) — the stable ATS id
 *   - `title`         role title
 *   - `description`   HTML job body
 *   - `companyDescription` HTML about-the-company text (fallback body)
 *   - `locality`      free-text location, e.g. "Guebwiller (68) - Grand Est"
 *   - `publicationDate` ISO-8601 publication timestamp → `datePosted`
 *   - `recruiter` / `publisher` hiring company display name
 *   - `permanent`     boolean permanence flag
 *   - `url.jobOffer`  canonical detail path `/candidat/offres/…-{id}`
 *   - `url.jobOfferShort` short stable detail path `/jobads/{id}`
 *   - `url.redirect`  optional external apply URL (the tenant's underlying ATS)
 *   - `labels.contractTypeList[]` employment-type tokens (e.g. "CDI")
 *   - `labels.macroJobList[]` / `labels.jobList[]` job-family / department tokens
 *   - `status`        publication status ("PUBLISHED")
 *
 * Each offer object opens with `{"score":…,"temperature":…,"id":"{id}",…}` — that
 * `{"score":` token is the stable per-offer boundary the adapter anchors on (rather
 * than a nested field such as `jobOfferShort`, which sits in the inner `url` object).
 *
 * Each role's canonical public detail / apply URL is the short `/jobads/{id}` path on
 * the same tenant host:
 *
 *   https://career.{tenant}.cleverconnect.com/jobads/{id}
 *
 * The caller addresses a tenant by `companySlug` (the sub-domain label, e.g. `demo`)
 * or by `companyUrl` (a career-site URL on a `cleverconnect.com` host, from which the
 * tenant label is derived). An unknown tenant resolves to a host with no DNS record /
 * an empty board, so it degrades naturally to an empty result. A fetch error, an HTTP
 * 4xx, a DNS failure, or a malformed / un-decodable body degrades to an empty /
 * partial result rather than throwing, so a single bad tenant never breaks a batch run.
 *
 * Surface confidence (researched + verified live 2026-06-03, no authentication):
 *  - Confirmed the platform + tenant addressing
 *    (`career.{tenant}.cleverconnect.com/jobs`) and a real, named live tenant on it:
 *    `demo` (the CleverConnect demo career site, 20 open roles at time of research).
 *  - Confirmed the server pre-renders the full offer array as an Angular
 *    TransferState JSON blob (entity-encoded), each offer carrying the numeric `id`
 *    (the stable ATS id), `title`, `description` (HTML), `locality`,
 *    `recruiter`/`publisher`, `publicationDate`, `url.jobOffer` /
 *    `url.jobOfferShort` (`/jobads/{id}`), and `labels.contractTypeList` /
 *    `labels.macroJobList` (verified=true).
 */

/** Career-site host template; `{tenant}` is the customer sub-domain label. */
export const CLEVERCONNECT_HOST_TEMPLATE = 'https://career.{tenant}.cleverconnect.com';

/** Root domain — used to recognise tenant hosts/URLs passed via `companyUrl`. */
export const CLEVERCONNECT_ROOT_DOMAIN = 'cleverconnect.com';

/** Public candidate-facing board path (the scraping surface). */
export const CLEVERCONNECT_BOARD_PATH = '/jobs';

/** Short, stable per-role detail / apply path template (`/jobads/{id}`). */
export const CLEVERCONNECT_JOBADS_PATH = '/jobads/';

/**
 * Default internal results cap. Mirrors the sibling ATS adapters: the public DTO
 * default is small, but when a caller omits `resultsWanted` entirely we ingest up
 * to 100 of the tenant's open roles.
 */
export const CLEVERCONNECT_DEFAULT_RESULTS = 100;

/**
 * Hard ceiling on board documents fetched per scrape. The board pre-renders the full
 * tenant offer set into a single document (the SPA paginates client-side), so one
 * page is the norm; the ceiling guards any future server-side pagination.
 */
export const CLEVERCONNECT_MAX_PAGES = 50;

/** Default request headers. The board expects a browser-like UA + HTML Accept. */
export const CLEVERCONNECT_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
};

/**
 * The Angular TransferState hydration blob entity-encodes JSON punctuation. This map
 * reverses the encoding so the embedded payload can be parsed as JSON. Order matters
 * only in that `&a;` (ampersand) is decoded last is NOT required because each token is
 * distinct; we decode each token independently.
 */
export const CLEVERCONNECT_ENTITY_DECODE: ReadonlyArray<readonly [string, string]> = [
  ['&q;', '"'],
  ['&l;', '<'],
  ['&g;', '>'],
  ['&s;', "'"],
  ['&a;', '&'],
];

/**
 * The per-offer boundary token. Each offer object in the decoded TransferState array
 * opens with `{"score":…,"temperature":…,"id":"{id}",…}`; anchoring on `{"score":`
 * (rather than a nested field) locates the offer object's own opening brace reliably.
 */
export const CLEVERCONNECT_OFFER_MARKER = '{"score":';

/**
 * Matches the numeric CleverConnect offer id at the tail of a canonical job-offer
 * path (`/candidat/offres/offre-d-emploi-…-{id}` or `/jobads/{id}`).
 */
export const CLEVERCONNECT_OFFER_ID_REGEX = /(\d+)\s*$/;

/** Detects remote / home-working roles across the title, location, and contract fields. */
export const CLEVERCONNECT_REMOTE_REGEX =
  /\b(remote|t[ée]l[ée]travail|home[\s-]?(?:based|working|office)|work\s*from\s*home|wfh|telecommute|fully\s*remote|100\s*%\s*remote)\b/i;

/**
 * Env toggle for CleverConnect location heuristics (Spec 1689), layered on top
 * of the shared parser: the board's "City (dept) - Region[, Country]" locality
 * shape ("Guebwiller (68) - Grand Est") is split into city / state / country —
 * the pre-5125 behaviour. The shared parser keeps only the city and drops the
 * region. `false` / `0` / `off` / `no` → shared-parser output only; unset or
 * anything else → on.
 */
export const CLEVERCONNECT_LOCATION_HEURISTICS_ENV = 'CLEVERCONNECT_LOCATION_HEURISTICS';

export function cleverConnectLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[CLEVERCONNECT_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
