/**
 * Constants for the Umantis (Haufe Talent) recruiting platform.
 *
 * Umantis (umantis.com, DACH — Switzerland / Germany / Austria), the talent
 * management and e-recruiting product now part of Haufe Group ("Haufe Talent"),
 * hosts each customer tenant's branded, public, unauthenticated candidate-facing
 * job board on the shared application host, keyed by a stable numeric tenant id:
 *
 *   https://recruitingapp-{tenantId}.umantis.com/Jobs/All        (CH / global host)
 *   https://recruitingapp-{tenantId}.de.umantis.com/Jobs/All     (DE host variant)
 *
 * The board is **server-rendered HTML** (not a client-rendered SPA), so its
 * open-roles index is directly crawlable without authentication. The index lists
 * every open role as a canonical vacancy anchor of the form:
 *
 *   /Vacancies/{ID}/Description/{langCode}
 *
 * where `{ID}` is the stable numeric Umantis vacancy id (the ATS id) and
 * `{langCode}` is the description language variant (`1`, `2`, …). The same path,
 * resolved against the tenant host, is each role's canonical public detail URL.
 * Each detail page carries the role title (the page `<title>` is
 * "{title} | {organisation}"), a free-text location, an optional posting date
 * (rendered DACH-style `DD.MM.YYYY`), and an "Apply here / Hier bewerben" link to
 * the tenant's application flow.
 *
 * The caller addresses a tenant by `companySlug` (the numeric tenant id, optionally
 * carrying the `.de` host hint, e.g. `5476` or `5476.de`) or by `companyUrl` (any
 * board / vacancy URL on a `umantis.com` host, from which the host + tenant id are
 * derived). An unknown tenant id, an HTTP 4xx, a DNS failure, or a malformed body
 * degrades to an empty / partial result rather than throwing, so a single bad
 * tenant never breaks a batch run.
 *
 * Surface confidence (researched + verified live 2026-06-03, no authentication):
 *  - Confirmed the platform + tenant addressing
 *    (`recruitingapp-{tenantId}.umantis.com/Jobs/All`, and the `.de.umantis.com`
 *    host variant) and real, named tenants on it: `5476` (ASMPT, on
 *    `recruitingapp-5476.de.umantis.com`, 10+ open roles at time of research),
 *    `2698` (Swiss TPH), `2717` (Generali), `2388` (Haufe Group).
 *  - Confirmed the server-rendered index lists each role with the canonical vacancy
 *    URL shape `/Vacancies/{ID}/Description/{langCode}` (e.g.
 *    `/Vacancies/1410/Description/1`), with the numeric `{ID}` as the stable ATS id,
 *    and that each detail page renders the role `<title>`, location, posting date
 *    (`DD.MM.YYYY`), and an apply link (verified=true).
 */

/** Canonical CH / global application host root domain. */
export const UMANTIS_ROOT_DOMAIN = 'umantis.com';

/** Default host template for a numeric tenant id (CH / global host). */
export const UMANTIS_HOST_TEMPLATE = 'recruitingapp-{tenantId}.umantis.com';

/** German host variant template (some tenants are served on `.de.umantis.com`). */
export const UMANTIS_DE_HOST_TEMPLATE = 'recruitingapp-{tenantId}.de.umantis.com';

/** Public, server-rendered open-roles index path. This is the enumeration surface. */
export const UMANTIS_JOBS_PATH = '/Jobs/All';

/**
 * Query string appended to the index + detail requests. `lang=eng` prefers the
 * English board / description variant where a tenant offers one; tenants that only
 * publish in German simply ignore it and render their default language.
 */
export const UMANTIS_LANG_QUERY = 'lang=eng';

/**
 * Default internal results cap. Mirrors the sibling ATS adapters: the public DTO
 * default is small, but when a caller omits `resultsWanted` entirely we ingest up
 * to 100 of the tenant's open roles.
 */
export const UMANTIS_DEFAULT_RESULTS = 100;

/**
 * Hard ceiling on index pages fetched per scrape. The board renders the full tenant
 * open-roles set in a single `/Jobs/All` document, so one page is the norm; the
 * ceiling guards any future server-side pagination.
 */
export const UMANTIS_MAX_PAGES = 50;

/** Default request headers. The board expects a browser-like UA + HTML Accept. */
export const UMANTIS_HEADERS: Record<string, string> = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
};

/**
 * Matches a canonical Umantis vacancy detail link inside the index HTML, capturing
 * the numeric vacancy id and the trailing language code:
 *   /Vacancies/{ID}/Description/{langCode}
 * The id is the stable ATS id.
 */
export const UMANTIS_VACANCY_LINK_REGEX =
  /\/Vacancies\/(\d+)\/Description\/(\d+)/gi;

/**
 * Matches a DACH-style posting date (`DD.MM.YYYY`) in the index / detail text, used
 * to recover a role's posted date when present.
 */
export const UMANTIS_DATE_REGEX = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/;

/** Detects remote / home-office roles across the title, location, and body text. */
export const UMANTIS_REMOTE_REGEX =
  /\b(remote|home[\s-]?office|home[\s-]?(?:based|working)|work\s*from\s*home|wfh|telecommute|fully\s*remote|t[ée]l[ée]travail)\b/i;

/**
 * Env toggle for Umantis location heuristics (Spec 1689), layered on top of
 * the shared parser: a "City (Country)" label ("Munich (Germany)") maps the
 * parenthesised token to the country — the pre-5125 behaviour; the shared
 * parser folds it into the city ("Munich Germany"). Workplace / numeric
 * parentheticals ("(Hybrid)", "(80%)") are left to the parser. `false` / `0`
 * / `off` / `no` → shared-parser output only; unset or anything else → on.
 */
export const UMANTIS_LOCATION_HEURISTICS_ENV = 'UMANTIS_LOCATION_HEURISTICS';

export function umantisLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[UMANTIS_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
