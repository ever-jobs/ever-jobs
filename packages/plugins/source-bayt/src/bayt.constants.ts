import { Country } from '@ever-jobs/models';

/**
 * Bayt (bayt.com) constants (Spec 1710).
 *
 * The search listing is server-rendered HTML:
 *
 *   GET https://www.bayt.com/en/{countryPath}/jobs/{slug}-jobs/?page={n}
 *   GET https://www.bayt.com/en/{countryPath}/jobs/?page={n}      (browse)
 *
 * robots.txt (checked 2026-09-24) disallows the country-less `/en/jobs/...`
 * form and any `filters[` / `options[` query parameter, so the builder only
 * ever emits a country-scoped path with `page` as its sole parameter, and
 * every filter the caller asks for is applied client-side.
 */

export const BAYT_BASE_URL = 'https://www.bayt.com';

/** Content negotiation for an HTML page. The User-Agent is left to the platform. */
export const BAYT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
});

/** Path segment used when no Bayt market is requested. */
export const BAYT_DEFAULT_COUNTRY_PATH = 'international';

/**
 * Bayt market path per `Country`. Only `uae` and `saudi-arabia` are well
 * established; the rest follow the same pattern and are to be confirmed on the
 * first reachable fetch. A wrong entry answers 404, which the shared error
 * classifier reports as `bad_input` - loud, never a silent empty result.
 */
export const BAYT_COUNTRY_PATHS: Readonly<Partial<Record<Country, string>>> = Object.freeze({
  [Country.UNITEDARABEMIRATES]: 'uae',
  [Country.SAUDIARABIA]: 'saudi-arabia',
  [Country.QATAR]: 'qatar',
  [Country.KUWAIT]: 'kuwait',
  [Country.BAHRAIN]: 'bahrain',
  [Country.OMAN]: 'oman',
  [Country.EGYPT]: 'egypt',
  [Country.MOROCCO]: 'morocco',
});

/**
 * Regional countries (lower-cased) that are not in `COUNTRY_CONFIG`. When the
 * shared location parser runs without ISO country names it reads
 * "Amman, Jordan" as `{ city: 'Amman', state: 'Jordan' }`; a state in this set
 * is promoted to `country`.
 */
export const BAYT_EXTRA_COUNTRIES: ReadonlySet<string> = new Set([
  'jordan',
  'lebanon',
  'algeria',
  'tunisia',
  'iraq',
  'palestine',
  'libya',
  'sudan',
  'syria',
  'yemen',
]);

/** Default cap on listing pages fetched per scrape. */
export const BAYT_MAX_PAGES = 10;
/** Hard ceiling for the page cap, whatever the env var or option says. */
export const BAYT_MAX_PAGES_CEILING = 50;

/** Random pause between listing pages, in milliseconds. */
export const BAYT_DELAY_MIN_MS = 2000;
export const BAYT_DELAY_MAX_MS = 5000;

/** Rows emitted when the caller does not say (matches the input DTO default). */
export const BAYT_DEFAULT_RESULTS = 15;

/** Card selector on a listing page. */
export const BAYT_CARD_SELECTOR = 'li[data-js-job]';

/** Environment switches (read on every scrape, so they flip without a rebuild). */
export const BAYT_ENV = Object.freeze({
  /** `true` restores the pre-1710 card mapping (id, title, jobUrl, location). */
  legacyMapping: 'EVER_JOBS_BAYT_LEGACY_MAPPING',
  /** `true` restores the pre-1710 slug (whitespace to `-`, nothing else). */
  legacySlug: 'EVER_JOBS_BAYT_LEGACY_SLUG',
  /** `false` always searches `/en/international/`, as before 1710. */
  countryScope: 'EVER_JOBS_BAYT_COUNTRY_SCOPE',
  /** Page cap, `1..BAYT_MAX_PAGES_CEILING` (default `BAYT_MAX_PAGES`). */
  maxPages: 'EVER_JOBS_BAYT_MAX_PAGES',
});

/** Per-scrape behaviour switches. Each defaults to its env var, then to the Spec 1710 behaviour. */
export interface BaytScrapeOptions {
  /** Emit the pre-1710 card mapping. Default `false`. */
  legacyMapping: boolean;
  /** Build the search slug the pre-1710 way. Default `false`. */
  legacySlug: boolean;
  /** Scope the search path by `country` / `location`. Default `true`. */
  countryScope: boolean;
  /** Listing pages fetched at most. Default {@link BAYT_MAX_PAGES}. */
  maxPages: number;
}

const FALSE_WORDS = ['false', '0', 'off', 'no'];
const TRUE_WORDS = ['true', '1', 'on', 'yes'];

function readFlag(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (TRUE_WORDS.includes(value)) return true;
  if (FALSE_WORDS.includes(value)) return false;
  return fallback;
}

function clampPages(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const whole = Math.floor(n);
  if (whole < 1) return null;
  return Math.min(whole, BAYT_MAX_PAGES_CEILING);
}

/**
 * Resolve the switches for one scrape: an explicit override wins, then the
 * env var, then the default. An unrecognised env value keeps the default.
 */
export function resolveBaytOptions(
  overrides: Partial<BaytScrapeOptions> = {},
  env: NodeJS.ProcessEnv = process.env,
): BaytScrapeOptions {
  return {
    legacyMapping:
      overrides.legacyMapping ?? readFlag(env[BAYT_ENV.legacyMapping], false),
    legacySlug: overrides.legacySlug ?? readFlag(env[BAYT_ENV.legacySlug], false),
    countryScope:
      overrides.countryScope ?? readFlag(env[BAYT_ENV.countryScope], true),
    maxPages:
      clampPages(overrides.maxPages) ?? clampPages(env[BAYT_ENV.maxPages]) ?? BAYT_MAX_PAGES,
  };
}
