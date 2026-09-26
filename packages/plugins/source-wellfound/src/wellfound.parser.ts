/**
 * Pure parsing and mapping for the Wellfound aggregator search (Spec 1708).
 *
 * Nothing here performs I/O or keeps state between calls, so every function
 * is safe to share across concurrent scrapes and is unit-tested directly.
 */
import {
  CompensationDto,
  CompensationInterval,
  DescriptionFormat,
  getJobTypeFromString,
  JobPostDto,
  looksLikeChallenge,
  Site,
} from '@ever-jobs/models';
import {
  extractEmails,
  htmlToPlainText,
  markdownConverter,
  parseLocationList,
  postedFromTimestamp,
  postedTimeFields,
} from '@ever-jobs/common';
import {
  locationUrl,
  jobsUrl,
  NEXT_DATA_RE,
  roleLocationUrl,
  roleRemoteUrl,
  roleUrl,
  WELLFOUND_BASE_URL,
  WELLFOUND_DEFAULT_DESCRIPTION_SOURCE,
  WELLFOUND_DEFAULT_JOB_URL_STYLE,
  WELLFOUND_REMOTE_LOCATION_WORDS,
  WELLFOUND_ROLE_ALIASES,
  WellfoundDescriptionSource,
  WellfoundJobUrlStyle,
  WellfoundRouteMode,
} from './wellfound.constants';
import {
  ApolloCache,
  ApolloEntity,
  WellfoundAnyListing,
  WellfoundJobListing,
  WellfoundLegacyCompensation,
  WellfoundListingPair,
  WellfoundNextData,
  WellfoundRemoteConfig,
  WellfoundSearchResultsConnection,
  WellfoundStartupResult,
} from './wellfound.types';

// ─── Small guards ───────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** A trimmed non-empty string, or null. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t ? t : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// ─── Payload extraction ─────────────────────────────────────────────────────

/** Parse the text of a `#__NEXT_DATA__` script. Null for anything but a JSON object. */
export function parseNextDataJson(json: string | null | undefined): WellfoundNextData | null {
  if (typeof json !== 'string' || !json.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return isPlainObject(parsed) ? (parsed as WellfoundNextData) : null;
  } catch {
    return null;
  }
}

/** The `#__NEXT_DATA__` document of an HTML page, or null when absent or broken. */
export function extractNextData(html: string | null | undefined): WellfoundNextData | null {
  if (typeof html !== 'string' || !html) return null;
  const match = NEXT_DATA_RE.exec(html);
  return match ? parseNextDataJson(match[1]) : null;
}

/** `props.pageProps.apolloState.data`, or null when the payload has another shape. */
export function getApolloData(nd: WellfoundNextData | null | undefined): ApolloCache | null {
  const data = nd?.props?.pageProps?.apolloState?.data;
  return isPlainObject(data) ? (data as ApolloCache) : null;
}

/**
 * Follow a `{__ref}` pointer, or return an inline object as it is. Only own
 * keys of the cache resolve, so a ref such as `__proto__` yields null.
 */
export function resolveRef<T = ApolloEntity>(data: ApolloCache, value: unknown): T | null {
  if (!isPlainObject(value)) return null;
  const ref = value.__ref;
  if (typeof ref === 'string') {
    if (!hasOwn(data, ref)) return null;
    const hit = data[ref];
    return isPlainObject(hit) ? (hit as unknown as T) : null;
  }
  return value as unknown as T;
}

const CONNECTION_FIELD = 'seoLandingPageJobSearchResults';

/** The JSON argument object of an Apollo field key such as `field({"page":2})`. */
function fieldArgs(key: string): Record<string, unknown> | null {
  const open = key.indexOf('(');
  if (open < 0 || !key.endsWith(')')) return null;
  try {
    const parsed: unknown = JSON.parse(key.slice(open + 1, -1));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The search-results connection of a landing page. It lives at
 * `ROOT_QUERY.talent["seoLandingPageJobSearchResults(<json args>)"]`; the key
 * order inside the arguments varies, so they are parsed rather than matched.
 * With several connections cached, the one whose `page` argument equals `page`
 * wins (a missing `page` argument counts as page 1).
 */
export function findSearchConnection(
  data: ApolloCache | null | undefined,
  page?: number,
): WellfoundSearchResultsConnection | null {
  if (!data || !hasOwn(data, 'ROOT_QUERY')) return null;
  const root = data.ROOT_QUERY;
  if (!isPlainObject(root)) return null;

  const found: Array<{ page: number; value: WellfoundSearchResultsConnection }> = [];
  const scan = (holder: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(holder)) {
      if (!key.startsWith(CONNECTION_FIELD) || !isPlainObject(value)) continue;
      const argPage = Number(fieldArgs(key)?.page ?? 1);
      found.push({ page: Number.isFinite(argPage) ? argPage : 1, value: value as WellfoundSearchResultsConnection });
    }
  };
  scan(root);
  for (const value of Object.values(root)) {
    const holder = resolveRef<Record<string, unknown>>(data, value);
    if (holder && holder !== root) scan(holder);
  }
  if (found.length === 0) return null;
  if (page !== undefined) {
    const exact = found.find((c) => c.page === page);
    if (exact) return exact.value;
  }
  return found[0].value;
}

const LISTING_TYPES: ReadonlySet<string> = new Set(['JobListingSearchResult', 'JobListing']);
const STARTUP_TYPES: ReadonlySet<string> = new Set(['StartupResult', 'Startup']);
/** Fields of a company node that point at its listings. */
const STARTUP_LISTING_FIELDS = ['highlightedJobListings', 'jobListings'] as const;

function isListingNode(value: unknown): value is WellfoundAnyListing {
  if (!isPlainObject(value)) return false;
  const typename = value.__typename;
  if (typename !== undefined && !(typeof typename === 'string' && LISTING_TYPES.has(typename))) return false;
  return typeof value.id === 'string' || typeof value.id === 'number';
}

function isStartupNode(value: unknown): value is WellfoundStartupResult {
  if (!isPlainObject(value)) return false;
  const typename = value.__typename;
  return typename === undefined || (typeof typename === 'string' && STARTUP_TYPES.has(typename));
}

/** A listing's id as a string, or null. */
export function listingId(listing: { id?: unknown } | null | undefined): string | null {
  const id = listing?.id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return text(id);
}

/** The remote config of a listing, inline or by reference. */
export function resolveRemoteConfig(
  listing: WellfoundAnyListing,
  data: ApolloCache,
): WellfoundRemoteConfig | null {
  return resolveRef<WellfoundRemoteConfig>(data, listing.remoteConfig);
}

/**
 * Every listing of one page with its company, in the site's ranking order.
 *
 * With a search-results connection, the order is `connection.startups[i]` then
 * that company's `highlightedJobListings[j]`. Without one (the `/jobs` feed),
 * every company node in object order, then any listing not reached that way,
 * its company taken from `listing.startup`. Listings are de-duplicated by id.
 */
export function collectListings(data: ApolloCache | null | undefined, page?: number): WellfoundListingPair[] {
  if (!data) return [];
  const out: WellfoundListingPair[] = [];
  const seen = new Set<string>();
  const push = (listing: WellfoundAnyListing, startup: WellfoundStartupResult | null): void => {
    const id = listingId(listing);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ listing, startup, remoteConfig: resolveRemoteConfig(listing, data) });
  };
  const pushStartup = (startup: WellfoundStartupResult): void => {
    for (const field of STARTUP_LISTING_FIELDS) {
      const refs = startup[field];
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        const listing = resolveRef(data, ref);
        if (isListingNode(listing)) push(listing, startup);
      }
    }
  };

  const connection = findSearchConnection(data, page);
  if (connection) {
    for (const ref of Array.isArray(connection.startups) ? connection.startups : []) {
      const startup = resolveRef(data, ref);
      if (isStartupNode(startup)) pushStartup(startup);
    }
    return out;
  }

  for (const entity of Object.values(data)) {
    if (isPlainObject(entity) && typeof entity.__typename === 'string' && STARTUP_TYPES.has(entity.__typename)) {
      pushStartup(entity as WellfoundStartupResult);
    }
  }
  for (const entity of Object.values(data)) {
    if (!isPlainObject(entity) || typeof entity.__typename !== 'string' || !LISTING_TYPES.has(entity.__typename)) {
      continue;
    }
    const listing = entity as WellfoundAnyListing;
    const owner = resolveRef(data, (listing as WellfoundJobListing).startup);
    push(listing, owner && isStartupNode(owner) ? owner : null);
  }
  return out;
}

/**
 * Whether a role landing page really is the requested role. The page's
 * `SeoRoleKeyword` node names the role the site resolved; without one, the
 * route's own `query.role` is the only evidence. Neither → not confirmed (a
 * redirect to another page, for instance).
 */
export function roleConfirmed(nd: WellfoundNextData, data: ApolloCache, role: string): boolean {
  let sawKeyword = false;
  for (const entity of Object.values(data)) {
    if (isPlainObject(entity) && entity.__typename === 'SeoRoleKeyword') {
      sawKeyword = true;
      if (entity.slug === role) return true;
    }
  }
  if (sawKeyword) return false;
  return nd.query?.role === role;
}

/**
 * A bot-challenge interstitial rather than a page. Normal pages carry the
 * CDN's passive detection beacon (`/cdn-cgi/challenge-platform/scripts/jsd/`),
 * which the shared heuristic would read as a challenge, so the beacon path is
 * removed before asking it.
 */
export function looksLikeWellfoundChallenge(html: string | null | undefined): boolean {
  if (typeof html !== 'string' || !html) return false;
  return looksLikeChallenge(html.replace(/\/cdn-cgi\/challenge-platform\/scripts\/jsd\//gi, '/cdn-cgi/jsd/'));
}

// ─── Compensation, size, experience ─────────────────────────────────────────

/** A currency sign, or a letter prefix plus `$` (`A$`, `CA$`). */
const CURRENCY_PREFIX = String.raw`(\p{Sc}|[A-Z]{1,3}\$)`;
/** `1,200,000`, or a number with an optional decimal part (`.` or `,`). */
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:[.,]\d+)?)`;
const COMPENSATION_RE = new RegExp(
  String.raw`^\s*${CURRENCY_PREFIX}?\s*${AMOUNT}\s*([kKmM])?` +
    String.raw`(?:\s*[\u2013\u2014-]\s*${CURRENCY_PREFIX}?\s*${AMOUNT}\s*([kKmM])?)?` +
    String.raw`\s*([A-Z]{3})?\b`,
  'u',
);

/** Longest compensation text looked at; the real strings are ~30 characters. */
const MAX_COMPENSATION_LENGTH = 200;

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  $: 'USD',
  'US$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '₹': 'INR',
  '¥': 'JPY',
  '₩': 'KRW',
  '₪': 'ILS',
  '₦': 'NGN',
  '₱': 'PHP',
  '₺': 'TRY',
  '₫': 'VND',
  '₽': 'RUB',
  '฿': 'THB',
  'A$': 'AUD',
  'AU$': 'AUD',
  'C$': 'CAD',
  'CA$': 'CAD',
  'S$': 'SGD',
  'NZ$': 'NZD',
  'HK$': 'HKD',
  'R$': 'BRL',
  'MX$': 'MXN',
});

/** ISO 4217 codes accepted as a trailing currency (`$126k – $187k CAD`). */
const ISO_CURRENCIES: ReadonlySet<string> = new Set([
  'USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'SGD', 'HKD', 'INR', 'JPY', 'CNY', 'KRW', 'TWD',
  'CHF', 'SEK', 'NOK', 'DKK', 'ISK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'UAH', 'TRY', 'ILS',
  'AED', 'SAR', 'QAR', 'EGP', 'ZAR', 'NGN', 'KES', 'GHS', 'MAD', 'BRL', 'MXN', 'ARS', 'CLP',
  'COP', 'PEN', 'UYU', 'PHP', 'IDR', 'MYR', 'THB', 'VND', 'PKR', 'BDT', 'LKR', 'NPR', 'RUB',
]);

function amountOf(raw: string | undefined, suffix: string | undefined): number | null {
  if (!raw) return null;
  const normalized = /^\d{1,3}(?:,\d{3})+$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(',', '.');
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return null;
  const scale = suffix === 'k' || suffix === 'K' ? 1e3 : suffix === 'm' || suffix === 'M' ? 1e6 : 1;
  return Math.round(n * scale * 100) / 100;
}

/**
 * The site's preformatted compensation (`"$130k – $210k • 0.05% – 0.2%"`,
 * `"$126k – $187k CAD"`, `""`) as a structured amount.
 *
 * Only the part before the bullet is read (the rest is equity). Each bound is
 * scaled by its own `k`/`m` suffix. A trailing ISO code wins over the sign
 * (`$…CAD` is CAD); otherwise the sign decides, and no sign means USD.
 * Hourly and monthly markers set the interval, anything else is yearly.
 * Empty, equity-only and unparseable strings give null.
 */
export function parseWellfoundCompensation(raw: unknown): CompensationDto | null {
  if (typeof raw !== 'string') return null;
  const head = raw.split('\u2022')[0].slice(0, MAX_COMPENSATION_LENGTH);
  if (!head.trim() || head.includes('%')) return null;

  const m = COMPENSATION_RE.exec(head);
  if (!m) return null;
  const [, signMin, rawMin, sufMin, signMax, rawMax, sufMax, iso] = m;
  const min = amountOf(rawMin, sufMin);
  const max = amountOf(rawMax, sufMax);
  if (min === null && max === null) return null;

  const sign = signMin ?? signMax;
  const currency =
    iso && ISO_CURRENCIES.has(iso)
      ? iso
      : sign && hasOwn(CURRENCY_SYMBOLS, sign)
        ? CURRENCY_SYMBOLS[sign]
        : 'USD';

  let interval = CompensationInterval.YEARLY;
  if (/\/\s*(?:hr|hour)\b|\bhourly\b|\bper hour\b/i.test(head)) interval = CompensationInterval.HOURLY;
  else if (/\/\s*(?:mo|month)\b|\bmonthly\b|\bper month\b/i.test(head)) interval = CompensationInterval.MONTHLY;

  return new CompensationDto({
    interval,
    minAmount: min ?? undefined,
    maxAmount: max ?? undefined,
    currency,
  });
}

/** The pre-Spec-1708 object form `{min, max, currency}`, mapped as it was then. */
function legacyCompensation(value: WellfoundLegacyCompensation): CompensationDto | null {
  if (value.min == null && value.max == null) return null;
  return new CompensationDto({
    interval: CompensationInterval.YEARLY,
    minAmount: value.min ?? undefined,
    maxAmount: value.max ?? undefined,
    currency: value.currency ?? 'USD',
  });
}

/** `SIZE_51_200` → `"51-200"`, `SIZE_10001_PLUS` → `"10001+"`, anything else → null. */
export function sizeToEmployees(size: unknown): string | null {
  if (typeof size !== 'string') return null;
  const range = /^SIZE_(\d{1,7})_(\d{1,7})$/.exec(size);
  if (range) return `${range[1]}-${range[2]}`;
  const plus = /^SIZE_(\d{1,7})_PLUS$/.exec(size);
  return plus ? `${plus[1]}+` : null;
}

/** `(3, 5)` → `"3-5 years"`, `(3, null)` → `"3+ years"`, `(null, 5)` → `"up to 5 years"`. */
export function experienceRange(min: unknown, max: unknown): string | null {
  const lo = finiteNonNegative(min);
  const hi = finiteNonNegative(max);
  if (lo !== null && hi !== null) return lo === hi ? `${lo} years` : `${lo}-${hi} years`;
  if (lo !== null) return `${lo}+ years`;
  if (hi !== null) return `up to ${hi} years`;
  return null;
}

// ─── Markdown ───────────────────────────────────────────────────────────────

/**
 * Backslash escapes are parked on private-use code points (U+E000 + the ASCII
 * code) so the emphasis rules below cannot see them, then restored.
 */
const ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!>~|])/g;
const PARKED_RE = /[\uE000-\uE07F]/g;

function parkEscapes(md: string): string {
  return md.replace(ESCAPE_RE, (_, ch: string) => String.fromCharCode(0xe000 + ch.charCodeAt(0)));
}

function restoreEscapes(value: string, html: boolean): string {
  return value.replace(PARKED_RE, (ch) => {
    const original = String.fromCharCode(ch.charCodeAt(0) - 0xe000);
    return html ? escapeHtml(original) : original;
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A heading's text without optional closing hashes (`## Title ##`). */
function headingText(value: string): string {
  let t = value.trimEnd();
  let i = t.length;
  while (i > 0 && t[i - 1] === '#') i--;
  if (i < t.length && (i === 0 || t[i - 1] === ' ' || t[i - 1] === '\t')) t = t.slice(0, i).trimEnd();
  return t;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const RULE_RE = /^(?:[-*_][ \t]*){3,}$/;
const BULLET_RE = /^[-*+][ \t]+(.*)$/;
const ORDERED_RE = /^\d{1,9}[.)][ \t]+(.*)$/;
const QUOTE_RE = /^>[ \t]?(.*)$/;

/**
 * Markdown to plain text: markers go, text stays. Headings and paragraphs keep
 * their line breaks, bullets become `• `, links keep their label.
 */
export function stripMarkdown(md: string | null | undefined): string {
  if (typeof md !== 'string' || !md) return '';
  const lines = parkEscapes(md.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw.trim();
    let m: RegExpExecArray | null;
    if (RULE_RE.test(line)) line = '';
    else if ((m = HEADING_RE.exec(line))) line = headingText(m[2]);
    else if ((m = BULLET_RE.exec(line))) line = `\u2022 ${m[1]}`;
    else if ((m = QUOTE_RE.exec(line))) line = m[1];
    line = line
      .replace(/`{3,}[^`]*$/, '')
      .replace(/!\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g, '$1')
      .replace(/\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g, '$1')
      .replace(/`([^`\n]{1,500})`/g, '$1')
      .replace(/\*\*/g, '')
      .replace(/__([^_\n]{1,1000})__/g, '$1')
      .replace(/\*([^*\n]{1,1000})\*/g, '$1')
      .replace(/(^|[^\p{L}\p{N}_])_([^_\n]{1,1000})_(?![\p{L}\p{N}_])/gu, '$1$2');
    out.push(line.trim());
  }
  return restoreEscapes(out.join('\n'), false)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inlineMarkdownToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`\n]{1,500})`/g, '<code>$1</code>')
    .replace(/\[([^\]\n]{0,500})\]\(([^()\s]{1,2000})\)/g, (_, label: string, url: string) =>
      /^https?:\/\//i.test(url) ? `<a href="${url}">${label}</a>` : label,
    )
    .replace(/\*\*([^*\n]{1,1000})\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]{1,1000})__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]{1,1000})\*/g, '<em>$1</em>')
    .replace(/(^|[^\p{L}\p{N}_])_([^_\n]{1,1000})_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>');
}

/**
 * Markdown to a small, safe HTML subset. The text is HTML-escaped first, so no
 * markup from the source survives; then headings, paragraphs, lists, bold,
 * italic, code spans and links are rendered. Only `http(s)` links become
 * anchors: any other scheme (`javascript:`) is left as its label.
 */
export function markdownToBasicHtml(md: string | null | undefined): string {
  if (typeof md !== 'string' || !md) return '';
  const lines = parkEscapes(md.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length) out.push(`<p>${paragraph.map(inlineMarkdownToHtml).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list) {
      const items = list.items.map((item) => `<li>${inlineMarkdownToHtml(item)}</li>`).join('');
      out.push(`<${list.tag}>${items}</${list.tag}>`);
    }
    list = null;
  };
  const addItem = (tag: 'ul' | 'ol', item: string): void => {
    flushParagraph();
    if (!list || list.tag !== tag) {
      flushList();
      list = { tag, items: [] };
    }
    list.items.push(item);
  };

  for (const raw of lines) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if (!line) {
      flushParagraph();
      flushList();
    } else if (RULE_RE.test(line)) {
      flushParagraph();
      flushList();
      out.push('<hr>');
    } else if ((m = HEADING_RE.exec(line))) {
      flushParagraph();
      flushList();
      const level = m[1].length;
      out.push(`<h${level}>${inlineMarkdownToHtml(headingText(m[2]))}</h${level}>`);
    } else if ((m = BULLET_RE.exec(line))) {
      addItem('ul', m[1]);
    } else if ((m = ORDERED_RE.exec(line))) {
      addItem('ol', m[1]);
    } else {
      flushList();
      paragraph.push((m = QUOTE_RE.exec(line)) ? m[1] : line);
    }
  }
  flushParagraph();
  flushList();
  return restoreEscapes(out.join('\n'), true);
}

// ─── Routing ────────────────────────────────────────────────────────────────

/** Lowercase ASCII slug: accents folded, `&` → `and`, other runs → `-`. */
function slugify(value: string): string {
  return value
    .slice(0, 200)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The role slug for a search term (`"Software Engineer"` → `software-engineer`), or null. */
export function roleSlug(term: string | null | undefined): string | null {
  if (typeof term !== 'string') return null;
  const key = term.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  if (hasOwn(WELLFOUND_ROLE_ALIASES, key)) return WELLFOUND_ROLE_ALIASES[key];
  return slugify(key) || null;
}

/** The place part of a location input: the text before the first comma. */
function locationHead(location: string): string {
  return location.split(',')[0].trim();
}

/** `"Remote"` (and `"Anywhere"`, `"Worldwide"`) mean remote work, not a place. */
export function isRemoteLocation(location: string | null | undefined): boolean {
  if (typeof location !== 'string') return false;
  return WELLFOUND_REMOTE_LOCATION_WORDS.has(locationHead(location).toLowerCase());
}

/** The location slug (`"San Francisco, CA"` → `san-francisco`), or null for none or remote. */
export function locationSlug(location: string | null | undefined): string | null {
  if (typeof location !== 'string') return null;
  const head = locationHead(location);
  if (!head || isRemoteLocation(head)) return null;
  return slugify(head) || null;
}

export type WellfoundRouteKind = 'role-location' | 'role-remote' | 'role' | 'location' | 'jobs';

/** Filters applied locally to a route's listings. */
export interface WellfoundLocalFilters {
  /** Search term every listing must contain; set only where the site did not filter by role. */
  term: string | null;
  /** Lowercased place matched against the listing's location names. */
  location: string | null;
  /** Keep remote-eligible listings only. */
  remote: boolean;
}

/** One entry of the fallback chain. */
export interface WellfoundRouteAttempt {
  kind: WellfoundRouteKind;
  /** Role slug the route asks for; confirmed against the page before it is trusted. */
  role: string | null;
  filters: WellfoundLocalFilters;
  /** Absolute URL of page `page` (1-based). */
  url(page: number): string;
}

export interface WellfoundRouteInput {
  searchTerm?: string | null;
  location?: string | null;
  isRemote?: boolean | null;
}

/**
 * The ordered route attempts for a search. Only robots-allowed paths are
 * produced: `/role/…`, `/location/…` and `/jobs`, never `/search`, never a
 * `role=`/`jobId=` query and never a `q=` (the site ignores it). The next
 * attempt is taken when a page 1 is missing or not the requested role; later
 * attempts filter locally for whatever the site no longer filters.
 */
export function planRoutes(
  input: WellfoundRouteInput,
  routeMode: WellfoundRouteMode = 'landing',
): WellfoundRouteAttempt[] {
  const term = text(input.searchTerm);
  const locationText = text(input.location);
  const locationIsRemote = isRemoteLocation(locationText);
  const remote = input.isRemote === true || locationIsRemote;
  const role = roleSlug(term);
  const loc = locationText && !locationIsRemote ? locationSlug(locationText) : null;
  const place = loc && locationText ? locationHead(locationText).toLowerCase() : null;

  const attempt = (
    kind: WellfoundRouteKind,
    url: (page: number) => string,
    filters: Partial<WellfoundLocalFilters>,
    attemptRole: string | null = null,
  ): WellfoundRouteAttempt => ({
    kind,
    role: attemptRole,
    filters: { term: filters.term ?? null, location: filters.location ?? null, remote: filters.remote ?? false },
    url,
  });
  const feed = (): WellfoundRouteAttempt =>
    attempt('jobs', (p) => jobsUrl(p), { term, location: place, remote });

  if (routeMode === 'feed') return [feed()];

  if (role) {
    if (remote) {
      return [attempt('role-remote', (p) => roleRemoteUrl(role, p), { location: place }, role), feed()];
    }
    if (loc) {
      return [
        attempt('role-location', (p) => roleLocationUrl(role, loc, p), {}, role),
        attempt('role', (p) => roleUrl(role, p), { location: place }, role),
        attempt('location', (p) => locationUrl(loc, p), { term }),
      ];
    }
    return [attempt('role', (p) => roleUrl(role, p), {}, role), feed()];
  }
  if (loc) {
    return [attempt('location', (p) => locationUrl(loc, p), { term, remote }), feed()];
  }
  return [feed()];
}

// ─── Local filters ──────────────────────────────────────────────────────────

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Search-term tokens: split on whitespace and punctuation other than `+` and
 * `#` (so `c++` and `c#` survive), single letters dropped except `c`.
 */
export function termTokens(term: string | null | undefined): string[] {
  if (typeof term !== 'string') return [];
  return term
    .slice(0, 200)
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((t) => t.length > 1 || t === 'c');
}

/** `token` at a word start; tokens of 1-2 characters must also end at a word end. */
function containsToken(haystack: string, token: string): boolean {
  const wholeWord = token.length <= 2;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(token, from);
    if (at < 0) return false;
    const startsWord = !isWordChar(haystack[at - 1]);
    const endsWord = !isWordChar(haystack[at + token.length]);
    if (startsWord && (!wholeWord || endsWord)) return true;
    from = at + 1;
  }
}

/** Whether `haystack` contains every token of `term` (case-insensitive). No tokens → true. */
export function matchesAllTerms(haystack: string, term: string | null | undefined): boolean {
  const tokens = termTokens(term);
  if (tokens.length === 0) return true;
  const lower = haystack.toLowerCase();
  return tokens.every((t) => containsToken(lower, t));
}

/** The text a local term filter searches: titles, company and description. */
export function listingSearchText(pair: WellfoundListingPair): string {
  const { listing, startup } = pair;
  const snippet = text((listing as WellfoundJobListing).descriptionSnippet);
  return [
    listing.title,
    listing.primaryRoleTitle,
    startup?.name ?? listing.company?.name,
    startup?.highConcept ?? listing.company?.highConcept,
    listing.description,
    snippet ? snippet.replace(/<[^>]*>/g, ' ') : null,
  ]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join('\n');
}

/** Whether any of the listing's location names contains `place` (case-insensitive). */
export function matchesPlace(listing: WellfoundAnyListing, place: string | null | undefined): boolean {
  const needle = text(place)?.toLowerCase();
  if (!needle) return true;
  return [...stringList(listing.locationNames), ...stringList(listing.acceptedRemoteLocationNames), ...stringList(listing.locations)]
    .some((name) => name.toLowerCase().includes(needle));
}

/** Posting instant in ms: `liveStartAt` (epoch seconds), else the legacy `createdAt`. */
export function listingPostedMs(listing: WellfoundAnyListing): number | null {
  const live = listing.liveStartAt;
  const n = typeof live === 'number' ? live : typeof live === 'string' && /^\d{9,13}$/.test(live.trim()) ? Number(live) : NaN;
  if (Number.isFinite(n) && n > 0) return n < 1e11 ? n * 1000 : n;
  const created = text(listing.createdAt);
  if (created) {
    const ms = Date.parse(created);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// ─── Mapping ────────────────────────────────────────────────────────────────

export interface WellfoundMapOptions {
  format?: DescriptionFormat | null;
  descriptionSource?: WellfoundDescriptionSource;
  jobUrlStyle?: WellfoundJobUrlStyle;
}

/** `https://wellfound.com/jobs/{id}-{slug}` (or the pre-Spec-1708 `/jobs/{slug}`). */
export function jobUrlFor(id: string, slug: string | null, style: WellfoundJobUrlStyle = WELLFOUND_DEFAULT_JOB_URL_STYLE): string {
  const base = `${WELLFOUND_BASE_URL}/jobs/`;
  if (style === 'slug') return `${base}${slug ?? id}`;
  return slug ? `${base}${id}-${slug}` : `${base}${id}`;
}

function descriptionFor(listing: WellfoundAnyListing, options: WellfoundMapOptions): string | null {
  const source = options.descriptionSource ?? WELLFOUND_DEFAULT_DESCRIPTION_SOURCE;
  const body = text(listing.description);

  if (body && source === 'html') {
    // The pre-Spec-1708 reading, kept verbatim behind the option.
    if (options.format === DescriptionFormat.HTML) return body;
    if (options.format === DescriptionFormat.MARKDOWN) return markdownConverter(body) ?? body;
    return htmlToPlainText(body);
  }
  if (body) {
    if (options.format === DescriptionFormat.PLAIN) return stripMarkdown(body) || null;
    if (options.format === DescriptionFormat.HTML) return markdownToBasicHtml(body) || null;
    return body;
  }

  // Feed and board nodes carry an HTML snippet instead of the Markdown body.
  const snippet = text((listing as WellfoundJobListing).descriptionSnippet);
  if (!snippet) return null;
  if (options.format === DescriptionFormat.HTML) return snippet;
  if (options.format === DescriptionFormat.PLAIN) return htmlToPlainText(snippet) || null;
  return markdownConverter(snippet) ?? snippet;
}

const REMOTE_KINDS: ReadonlySet<string> = new Set(['REMOTE', 'REMOTE_ONLY']);

/**
 * One listing and its company as a `JobPostDto`, or null when it has no id or
 * title. Pure: everything it needs is in `pair`.
 */
export function mapListing(pair: WellfoundListingPair, options: WellfoundMapOptions = {}): JobPostDto | null {
  const { listing, startup, remoteConfig } = pair;
  const id = listingId(listing);
  const title = text(listing.title);
  if (!id || !title) return null;

  const legacyCompany = isPlainObject(listing.company) ? listing.company : null;
  const companySlug = text(startup?.slug) ?? text(legacyCompany?.slug);
  const description = descriptionFor(listing, options);

  const locationNames = stringList(listing.locationNames);
  const labels = locationNames.length ? locationNames : stringList(listing.locations);
  const parsed = parseLocationList(labels);

  const kind = text(remoteConfig?.kind)?.toUpperCase() ?? null;
  const isRemote = listing.remote === true || (kind !== null && REMOTE_KINDS.has(kind)) || parsed.remoteMentioned;
  let workFromHomeType: string | null = parsed.workFromHomeType ?? null;
  if (kind !== null && REMOTE_KINDS.has(kind)) workFromHomeType = 'Remote';
  else if (kind === 'ONSITE_OR_REMOTE') workFromHomeType = 'Hybrid or Remote';
  else if (kind === 'ONSITE' && remoteConfig?.wfhFlexible === true) workFromHomeType = 'Hybrid';

  const compensation =
    typeof listing.compensation === 'string'
      ? parseWellfoundCompensation(listing.compensation)
      : isPlainObject(listing.compensation)
        ? legacyCompensation(listing.compensation as WellfoundLegacyCompensation)
        : null;

  const postedMs = listingPostedMs(listing);
  const posted =
    postedMs !== null
      ? postedTimeFields(postedFromTimestamp(postedMs))
      : { datePosted: null };

  const rawJobType = text(listing.jobType);
  const jobType = getJobTypeFromString(rawJobType);
  const skills = stringList(listing.skills);

  return new JobPostDto({
    id: `wellfound-${id}`,
    title,
    companyName: text(startup?.name) ?? text(legacyCompany?.name),
    companyUrl: companySlug ? `${WELLFOUND_BASE_URL}/company/${companySlug}` : null,
    companyLogo: text(startup?.logoUrl) ?? text(legacyCompany?.logoUrl),
    companyDescription: text(startup?.highConcept) ?? text(legacyCompany?.highConcept),
    companyNumEmployees: sizeToEmployees(startup?.companySize ?? legacyCompany?.companySize),
    jobUrl: jobUrlFor(id, text(listing.slug), options.jobUrlStyle),
    location: labels.length ? parsed.location : null,
    ...(parsed.locations.length > 0 ? { locations: parsed.locations } : {}),
    description,
    compensation,
    ...posted,
    ...(jobType ? { jobType: [jobType] } : {}),
    employmentType: rawJobType,
    department: text(listing.primaryRoleTitle),
    experienceRange: experienceRange(listing.yearsExperienceMin, listing.yearsExperienceMax),
    isRemote,
    workFromHomeType,
    emails: extractEmails(description),
    site: Site.WELLFOUND,
    skills: skills.length ? skills : null,
  });
}
