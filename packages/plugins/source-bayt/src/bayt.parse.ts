import * as cheerio from 'cheerio';
import {
  COUNTRY_CONFIG,
  Country,
  JobPostDto,
  LocationDto,
  ScrapeDiagnostics,
  ScraperInputDto,
  Site,
  classifyScrapeError,
  looksLikeChallenge,
} from '@ever-jobs/models';
import {
  ParseLocationOptions,
  ParsedLocationList,
  parseLocationList,
  parseLocationText,
  parseRelativeAge,
  postedFromRelativeLabel,
  postedTimeFields,
  relativeAgeToMs,
} from '@ever-jobs/common';
import {
  BAYT_BASE_URL,
  BAYT_CARD_SELECTOR,
  BAYT_COUNTRY_PATHS,
  BAYT_DEFAULT_COUNTRY_PATH,
  BAYT_EXTRA_COUNTRIES,
} from './bayt.constants';

/**
 * Pure, cheerio-only parsing for the Bayt listing (Spec 1710). Nothing here
 * touches the network or reads the clock: time is always a parameter.
 */

/** Letters NFKD leaves whole, spelled the way an ASCII slug writes them. */
const TRANSLITERATIONS: Readonly<Record<string, string>> = {
  ß: 'ss',
  ẞ: 'ss',
  æ: 'ae',
  Æ: 'ae',
  ø: 'o',
  Ø: 'o',
  œ: 'oe',
  Œ: 'oe',
  ł: 'l',
  Ł: 'l',
  đ: 'd',
  Đ: 'd',
  ð: 'd',
  Ð: 'd',
  þ: 'th',
  Þ: 'th',
  ı: 'i',
};
const TRANSLITERATION_RE = new RegExp(`[${Object.keys(TRANSLITERATIONS).join('')}]`, 'g');

/**
 * Normalise a search term into Bayt's `<slug>-jobs` path token: letters that
 * NFKD cannot decompose are transliterated first (`ß` -> `ss`, `ø` -> `o`),
 * then NFKD, combining marks stripped, lower-cased, whitespace to `-`, every
 * other character outside `[a-z0-9-]` dropped, repeated `-` collapsed and
 * leading/trailing `-` trimmed. A term with no ASCII letter or digit left
 * (`'مهندس'`, `'+++'`) yields `''`.
 *
 * Symbol-bearing skills lose their symbols (`'C++ developer'` ->
 * `'c-developer'`); how Bayt itself spells them is an open question, pinned by
 * a test so a later change is deliberate.
 */
export function toBaytSlug(term: string | null | undefined): string {
  if (typeof term !== 'string') return '';
  return term
    .replace(TRANSLITERATION_RE, (ch) => TRANSLITERATIONS[ch] ?? ch)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The pre-1710 slug (`EVER_JOBS_BAYT_LEGACY_SLUG`): whitespace runs to `-`,
 * nothing else. The characters that would change the request's shape - `/`,
 * `?`, `#`, `\` - are percent-encoded so a term cannot add a path segment or a
 * query parameter (robots.txt forbids `filters[`); everything else goes out as
 * the HTTP client would have encoded it.
 */
export function legacyBaytSlug(term: string | null | undefined): string {
  if (typeof term !== 'string') return '';
  const raw = term.trim().replace(/\s+/g, '-');
  return encodeURI(raw).replace(/[/?#\\]/g, (ch) => encodeURIComponent(ch));
}

/** `Country` whose configured names include `name` (case-insensitive), else `null`. */
export function countryFromDisplayName(name: string | null | undefined): Country | null {
  const wanted = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (!wanted) return null;
  for (const [country, config] of Object.entries(COUNTRY_CONFIG)) {
    if (config.names.split(',').some((n) => n.trim() === wanted)) {
      return country as Country;
    }
  }
  return null;
}

/**
 * Bayt market path for a search.
 *
 * 1. `country`, when it is a Bayt market (see `BAYT_COUNTRY_PATHS`).
 * 2. Otherwise the country the shared parser reads from `location`
 *    (`'Dubai, UAE'` -> `uae`), when that is a Bayt market.
 * 3. Otherwise `international`.
 *
 * A non-market `country` counts as "not requested" because the input DTO
 * defaults `country` to `USA`: honouring it literally would make `location`
 * unreachable for every API caller.
 */
export function resolveCountryPath(
  input: Pick<ScraperInputDto, 'country' | 'location'> | null | undefined,
): string {
  const fromCountry = input?.country ? BAYT_COUNTRY_PATHS[input.country] : undefined;
  if (fromCountry) return fromCountry;

  if (typeof input?.location === 'string' && input.location.trim()) {
    const parsed = parseLocationText(input.location);
    const country = countryFromDisplayName(
      typeof parsed.location?.country === 'string' ? parsed.location.country : null,
    );
    const fromLocation = country ? BAYT_COUNTRY_PATHS[country] : undefined;
    if (fromLocation) return fromLocation;
  }

  return BAYT_DEFAULT_COUNTRY_PATH;
}

const COUNTRY_PATH_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** robots.txt (`User-agent: *`) rules a search URL could otherwise trip. */
const ROBOTS_DISALLOWED_RE = /^\/(?:en|ar|fr)\/jobs\/|filters\[|filters%5|options\[|options%5/i;

/**
 * Absolute listing URL for one page. An empty slug browses the market.
 *
 * Throws rather than emit a path robots.txt disallows (the country-less
 * `/en/jobs/...` form, `filters[` / `options[` in any spelling) or a market
 * segment that is not a plain token.
 */
export function buildSearchUrl(countryPath: string, slug: string, page: number): string {
  if (!COUNTRY_PATH_RE.test(countryPath ?? '')) {
    throw new Error(`Refusing Bayt search path: bad market segment "${countryPath}"`);
  }
  const pageNo = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const path = slug
    ? `/en/${countryPath}/jobs/${slug}-jobs/`
    : `/en/${countryPath}/jobs/`;
  if (ROBOTS_DISALLOWED_RE.test(path)) {
    throw new Error(`Refusing robots-disallowed Bayt search path ${path}`);
  }
  return `${BAYT_BASE_URL}${path}?page=${pageNo}`;
}

/**
 * Canonical job URL: resolved against bayt.com, query string and fragment
 * dropped (robots.txt `Clean-param` lists tracking parameters only, so the
 * same posting keeps one URL). Anything that is not http(s) yields `null`.
 */
export function canonicalJobUrl(href: string | null | undefined): string | null {
  if (typeof href !== 'string' || !href.trim()) return null;
  let url: URL;
  try {
    url = new URL(href.trim(), BAYT_BASE_URL);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** 32-bit string hash, as the plugin has always used for its fallback id. */
export function baytHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export type BaytIdSource = 'data-job-id' | 'url' | 'hash';

/**
 * Stable job id: `bayt-<n>` from the card's `data-job-id`, else the trailing
 * `-<digits>/` of the URL path (5+ digits), else a hash of the canonical URL.
 */
export function extractJobId(
  dataJobId: string | null | undefined,
  canonicalUrl: string,
): { id: string; source: BaytIdSource } {
  const attr = typeof dataJobId === 'string' ? dataJobId.trim() : '';
  if (/^\d{1,19}$/.test(attr)) return { id: `bayt-${attr}`, source: 'data-job-id' };

  let path = '';
  try {
    path = new URL(canonicalUrl).pathname;
  } catch {
    path = '';
  }
  const digits = /-(\d{5,19})\/?$/.exec(path);
  if (digits) return { id: `bayt-${digits[1]}`, source: 'url' };

  return { id: `bayt-${Math.abs(baytHash(canonicalUrl))}`, source: 'hash' };
}

/** What the location cell yields: the shared parser's output, after regional promotion. */
export type BaytLocation = Pick<
  ParsedLocationList,
  'location' | 'locations' | 'remoteMentioned' | 'workFromHomeType'
>;

/** Longer location text cannot be a card's location cell; the rest is dropped. */
const MAX_LOCATION_TEXT = 300;

/**
 * Location text as the shared parser reads it: `·`, `•` and `|` become comma
 * separators (the parser does not split on them), whitespace collapses, and
 * stray edge commas go. Bounded, and linear in the input.
 */
export function normaliseBaytLocation(text: string | null | undefined): string {
  if (typeof text !== 'string') return '';
  let out = text
    .slice(0, MAX_LOCATION_TEXT)
    .replace(/\s+/g, ' ')
    .replace(/ ?[·•|] ?/g, ', ')
    .trim();
  while (out.startsWith(',')) out = out.slice(1).trimStart();
  while (out.endsWith(',')) out = out.slice(0, -1).trimEnd();
  return out;
}

/** Location cell text: two or more anchors joined with `', '`, else the cell's text. */
export function baytLocationText(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<any>,
): string {
  const anchors = el.children('a');
  const raw =
    anchors.length >= 2
      ? anchors
          .toArray()
          .map((a) => $(a).text().trim())
          .filter(Boolean)
          .join(', ')
      : el.text();
  return normaliseBaytLocation(raw);
}

function promoteRegionalCountry(loc: LocationDto): LocationDto {
  if (loc.country || typeof loc.state !== 'string') return loc;
  if (!BAYT_EXTRA_COUNTRIES.has(loc.state.trim().toLowerCase())) return loc;
  const { state, ...rest } = loc;
  return new LocationDto({ ...rest, country: state });
}

/**
 * Parse a card's location cell (`City · Country` as two anchors, or plain
 * `City, Country` text). The shared parser does not split on `·`, so it is
 * normalised to a comma first. A regional country the parser reports as a
 * state (see `BAYT_EXTRA_COUNTRIES`) is promoted to `country`.
 *
 * `null` when the cell is empty or nothing at all parses - never a
 * fabricated `WORLDWIDE`.
 */
export function parseBaytLocation(
  $: cheerio.CheerioAPI,
  el: cheerio.Cheerio<any> | null | undefined,
  options?: ParseLocationOptions,
): BaytLocation | null {
  if (!el || el.length === 0) return null;
  return parseBaytLocationText(baytLocationText($, el), options);
}

/** {@link parseBaytLocation} for already-extracted text. */
export function parseBaytLocationText(
  text: string | null | undefined,
  options?: ParseLocationOptions,
): BaytLocation | null {
  const normalised = normaliseBaytLocation(text);
  if (!normalised) return null;

  const parsed = parseLocationList([normalised], options);
  const location = parsed.location ? promoteRegionalCountry(parsed.location) : null;
  const locations = parsed.locations.map(promoteRegionalCountry);
  if (!location && locations.length === 0 && !parsed.remoteMentioned && !parsed.workFromHomeType) {
    return null;
  }
  return {
    location,
    locations,
    remoteMentioned: parsed.remoteMentioned,
    workFromHomeType: parsed.workFromHomeType,
  };
}

const MAX_POSTED_TEXT = 200;
const POSTED_LABEL_RE =
  /\b(just now|today|yesterday|\d{1,4}\+?\s*(?:minute|min|hour|hr|day|week|month|year)s?\s+ago)\b/i;

/**
 * The age label inside a posted-date cell (`'Today'`, `'3 days ago'`,
 * `'30+ days ago'`), whitespace collapsed; `null` when there is none.
 */
export function baytPostedLabel(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const collapsed = text.slice(0, MAX_POSTED_TEXT).replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (parseRelativeAge(collapsed)) return collapsed;
  const match = POSTED_LABEL_RE.exec(collapsed);
  if (!match) return null;
  const label = match[1].replace(/\s+/g, ' ');
  return parseRelativeAge(label) ? label : null;
}

/** Age of a posted label in milliseconds (`'30+ days ago'` is a lower bound: 30 days). */
export function baytPostedAgeMs(text: string | null | undefined): number | null {
  const label = baytPostedLabel(text);
  const age = label ? parseRelativeAge(label) : null;
  return age ? relativeAgeToMs(age) : null;
}

/**
 * Posting instant from a relative label: `today` / `just now` -> `now`,
 * `yesterday` -> one day earlier, `N <unit>s ago` -> `now` minus that.
 * Anything else -> `null`.
 */
export function parseRelativePosted(
  text: string | null | undefined,
  now: Date | number,
): Date | null {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) return null;
  const ageMs = baytPostedAgeMs(text);
  return ageMs === null ? null : new Date(nowMs - ageMs);
}

/** One parsed listing card, before it becomes a `JobPostDto`. */
export interface BaytCard {
  id: string;
  idSource: BaytIdSource;
  /** `h2` text, whitespace collapsed. */
  title: string;
  /** Canonical absolute URL: no query string, no fragment. */
  jobUrl: string;
  companyName: string | null;
  companyUrl: string | null;
  location: BaytLocation | null;
  /** Relative age label, when the card carries one. */
  postedLabel: string | null;
  /** Age from {@link postedLabel} in ms (a lower bound), else `null`. */
  postedAgeMs: number | null;
  /** The pre-1710 readings, kept for `EVER_JOBS_BAYT_LEGACY_MAPPING`. */
  legacy: {
    /** `href` as the card carried it, trimmed. */
    href: string;
    /** Every `h2` text, trimmed but not collapsed. */
    title: string;
    /** Every location cell's text, trimmed; `null` when empty. */
    locationText: string | null;
  };
}

export interface BaytListing {
  /** `li[data-js-job]` elements on the page. */
  cards: number;
  /** Cards that parsed. */
  jobs: BaytCard[];
  /** Cards skipped as unparseable (no title link, bad URL, empty title). */
  failed: number;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Parse one card; `null` when it has no usable title link. */
export function parseCard(
  $: cheerio.CheerioAPI,
  card: cheerio.Cheerio<any>,
  options?: ParseLocationOptions,
): BaytCard | null {
  const h2 = card.find('h2');
  if (!h2.length) return null;
  const href = h2.find('a').attr('href')?.trim();
  if (!href) return null;
  const jobUrl = canonicalJobUrl(href);
  if (!jobUrl) return null;
  const title = collapse(h2.first().text());
  if (!title) return null;

  const { id, source } = extractJobId(card.attr('data-job-id'), jobUrl);

  const companyDiv = card.find('div.t-nowrap.p10l').first();
  const companySpan = companyDiv.find('span').first();
  const companyName = collapse(companySpan.text()) || null;
  const parentAnchor = companySpan.closest('a[href*="/company/"]');
  const companyAnchor = parentAnchor.length
    ? parentAnchor
    : companyDiv.find('a[href*="/company/"]').first();
  const companyUrl = companyAnchor.length
    ? canonicalJobUrl(companyAnchor.attr('href'))
    : null;

  const location = parseBaytLocation($, card.find('div.t-mute.t-small').first(), options);

  const postedText = card.find('[data-automation-id="job-active-date"]').first().text();
  const postedLabel = baytPostedLabel(postedText);
  const postedAge = postedLabel ? parseRelativeAge(postedLabel) : null;

  return {
    id,
    idSource: source,
    title,
    jobUrl,
    companyName,
    companyUrl,
    location,
    postedLabel,
    postedAgeMs: postedAge ? relativeAgeToMs(postedAge) : null,
    legacy: {
      href,
      title: h2.text().trim(),
      locationText: card.find('div.t-mute.t-small').text().trim() || null,
    },
  };
}

/** Parse a listing page into cards; a card that throws or lacks a link counts as failed. */
export function parseListing(html: string, options?: ParseLocationOptions): BaytListing {
  const $ = cheerio.load(typeof html === 'string' ? html : '');
  const nodes = $(BAYT_CARD_SELECTOR).toArray();
  const jobs: BaytCard[] = [];
  let failed = 0;
  for (const node of nodes) {
    try {
      const card = parseCard($, $(node), options);
      if (card) jobs.push(card);
      else failed++;
    } catch {
      failed++;
    }
  }
  return { cards: nodes.length, jobs, failed };
}

/**
 * Map a card to a `JobPostDto`. `nowMs` anchors relative posted labels.
 * `legacyMapping` reproduces the pre-1710 output verbatim: a hash id over the
 * raw joined URL, the untouched `h2` text, `BASE + href` as `jobUrl`, and the
 * raw location text as `city` with `Country.WORLDWIDE`.
 */
export function toJobPost(
  card: BaytCard,
  nowMs: number,
  options: { legacyMapping?: boolean } = {},
): JobPostDto {
  if (options.legacyMapping) {
    const jobUrl = `${BAYT_BASE_URL}${card.legacy.href}`;
    return new JobPostDto({
      id: `bayt-${Math.abs(baytHash(jobUrl))}`,
      title: card.legacy.title,
      companyName: card.companyName,
      location: new LocationDto({
        city: card.legacy.locationText,
        country: Country.WORLDWIDE,
      }),
      jobUrl,
      site: Site.BAYT,
    });
  }

  const loc = card.location;
  return new JobPostDto({
    id: card.id,
    title: card.title,
    companyName: card.companyName,
    companyUrl: card.companyUrl,
    jobUrl: card.jobUrl,
    location: loc?.location ?? null,
    ...(loc && loc.locations.length > 0 ? { locations: loc.locations } : {}),
    isRemote: loc?.remoteMentioned || null,
    workFromHomeType: loc?.workFromHomeType ?? null,
    ...postedTimeFields(postedFromRelativeLabel(card.postedLabel, nowMs)),
    site: Site.BAYT,
  });
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const h = headers as { get?: unknown } & Record<string, unknown>;
  let raw: unknown =
    typeof h.get === 'function' ? (h.get as (key: string) => unknown).call(headers, name) : undefined;
  if (raw === undefined || raw === null) {
    const key = Object.keys(h).find((k) => k.toLowerCase() === name);
    raw = key === undefined ? undefined : h[key];
  }
  if (Array.isArray(raw)) raw = raw.join(', ');
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null;
}

/**
 * Diagnostics for a failed fetch. A response flagged `cf-mitigated: challenge`
 * (or whose body is a challenge page) is `blocked` with a precise detail;
 * anything else goes to the shared classifier unchanged.
 */
export function baytFetchDiagnostics(err: unknown): ScrapeDiagnostics {
  const response = (err as { response?: { status?: unknown; headers?: unknown; data?: unknown } })
    ?.response;
  if (response) {
    const status = typeof response.status === 'number' ? response.status : null;
    const statusText = status === null ? 'HTTP error' : `HTTP ${status}`;
    const mitigated = headerValue(response.headers, 'cf-mitigated');
    if (mitigated && /challenge/i.test(mitigated)) {
      return new ScrapeDiagnostics(
        'blocked',
        `bayt.com served a Cloudflare managed challenge (${statusText}, cf-mitigated: challenge)`,
      );
    }
    if (typeof response.data === 'string' && looksLikeChallenge(response.data)) {
      return new ScrapeDiagnostics(
        'blocked',
        `bayt.com served a bot challenge page (${statusText})`,
      );
    }
  }
  return classifyScrapeError(err);
}
