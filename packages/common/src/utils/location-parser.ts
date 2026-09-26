import { Logger } from '@nestjs/common';
import { LocationDto } from '@ever-jobs/models';
import {
  COUNTRY_CONFIG,
  Country,
  getIndeedDomain,
} from '@ever-jobs/models';
import { regionNameFromCode } from './country-name';
import { ISO_ALPHA2_TO_ALPHA3, ISO_ALPHA3_TO_ALPHA2 } from './iso3166';

const logger = new Logger('LocationParser');

const US_STATE_AND_TERRITORY_CODES = new Set([
  'AA',
  'AE',
  'AK',
  'AL',
  'AP',
  'AR',
  'AS',
  'AZ',
  'CA',
  'CO',
  'CT',
  'DC',
  'DE',
  'FL',
  'FM',
  'GA',
  'GU',
  'HI',
  'IA',
  'ID',
  'IL',
  'IN',
  'KS',
  'KY',
  'LA',
  'MA',
  'MD',
  'ME',
  'MH',
  'MI',
  'MN',
  'MO',
  'MP',
  'MS',
  'MT',
  'NC',
  'ND',
  'NE',
  'NH',
  'NJ',
  'NM',
  'NV',
  'NY',
  'OH',
  'OK',
  'OR',
  'PA',
  'PR',
  'PW',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VA',
  'VI',
  'VT',
  'WA',
  'WI',
  'WV',
  'WY',
]);

const US_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  georgia: 'GA',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  washington: 'WA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
  'district of columbia': 'DC',
};

/**
 * US territory names — emitted verbatim as the subdivision (matching the
 * generic 'City, Subdivision' convention for names like 'Ontario') rather
 * than as a code most readers won't recognize ('PR').
 */
const US_TERRITORY_NAMES: Record<string, string> = {
  'american samoa': 'American Samoa',
  guam: 'Guam',
  'northern mariana islands': 'Northern Mariana Islands',
  'puerto rico': 'Puerto Rico',
  'u.s. virgin islands': 'U.S. Virgin Islands',
  'virgin islands': 'U.S. Virgin Islands',
};

/** Display names emitted for territories — count as US for merge/firm. */
const US_TERRITORY_DISPLAY_NAMES = new Set(Object.values(US_TERRITORY_NAMES));

/**
 * ISO-3166-1 alpha-3 display names for every country in COUNTRY_CONFIG, plus
 * `UAE` as an alias for `ARE` (boards write "UAE" often). `Intl.DisplayNames`
 * only accepts alpha-2 codes, so alpha-3 needs this explicit map.
 *
 * These codes resolve case-insensitively ('gbr'). With `isoCountryNames`
 * (Spec 1699) their NAME comes from the ISO table + CLDR instead, so 'CZE'
 * reads as 'Czechia' like the name does; these spellings are the legacy
 * output (`isoCountryNames: false`).
 */
const COUNTRY_ALPHA3: Record<string, string> = {
  ARE: 'United Arab Emirates',
  ARG: 'Argentina',
  AUS: 'Australia',
  AUT: 'Austria',
  BEL: 'Belgium',
  BGR: 'Bulgaria',
  BHR: 'Bahrain',
  BRA: 'Brazil',
  CAN: 'Canada',
  CHE: 'Switzerland',
  CHL: 'Chile',
  CHN: 'China',
  COL: 'Colombia',
  CRI: 'Costa Rica',
  CYP: 'Cyprus',
  CZE: 'Czech Republic',
  DEU: 'Germany',
  DNK: 'Denmark',
  ECU: 'Ecuador',
  EGY: 'Egypt',
  ESP: 'Spain',
  EST: 'Estonia',
  FIN: 'Finland',
  FRA: 'France',
  GBR: 'United Kingdom',
  GRC: 'Greece',
  HKG: 'Hong Kong',
  HUN: 'Hungary',
  IDN: 'Indonesia',
  IND: 'India',
  IRL: 'Ireland',
  ISR: 'Israel',
  ITA: 'Italy',
  JPN: 'Japan',
  KOR: 'South Korea',
  KWT: 'Kuwait',
  LTU: 'Lithuania',
  LVA: 'Latvia',
  LUX: 'Luxembourg',
  MAR: 'Morocco',
  MEX: 'Mexico',
  MLT: 'Malta',
  MYS: 'Malaysia',
  NGA: 'Nigeria',
  NLD: 'Netherlands',
  NOR: 'Norway',
  NZL: 'New Zealand',
  OMN: 'Oman',
  PAK: 'Pakistan',
  PAN: 'Panama',
  PER: 'Peru',
  PHL: 'Philippines',
  POL: 'Poland',
  PRT: 'Portugal',
  QAT: 'Qatar',
  ROU: 'Romania',
  SAU: 'Saudi Arabia',
  SGP: 'Singapore',
  SVK: 'Slovakia',
  SVN: 'Slovenia',
  SWE: 'Sweden',
  THA: 'Thailand',
  TUR: 'Turkey',
  TWN: 'Taiwan',
  UAE: 'United Arab Emirates',
  UKR: 'Ukraine',
  URY: 'Uruguay',
  USA: 'United States',
  VEN: 'Venezuela',
  VNM: 'Vietnam',
  ZAF: 'South Africa',
};

/**
 * State names that collide with prominent city names — a bare label is too
 * ambiguous to resolve to a state ('Washington' DC?, 'New York' the city?,
 * 'Georgia' the country?). Codes stay unambiguous and always resolve.
 */
const BARE_STATE_NAME_COLLISIONS = new Set(['washington', 'new york', 'georgia']);

/**
 * Georgian cities and regions (lower-case, diacritics folded) that make a
 * trailing 'Georgia' the COUNTRY: 'Tbilisi, Georgia', 'Batumi, Adjara,
 * Georgia'. Without one of them 'Georgia' stays the US state ('Atlanta,
 * Georgia') or, bare, a city — the name is never read as the country alone.
 */
const GEORGIA_COUNTRY_PLACES = new Set([
  'tbilisi', 'batumi', 'kutaisi', 'rustavi', 'zugdidi', 'gori', 'poti',
  'telavi', 'adjara', 'ajara', 'imereti', 'kakheti', 'kvemo kartli',
  'samegrelo-zemo svaneti', 'shida kartli', 'mtskheta-mtianeti',
]);

/**
 * Subdivisions (lower-case names and codes) that pin an ambiguous tail code —
 * one that is both a US state and an ISO country — to its COUNTRY reading
 * even when US-state-first is on: 'Toronto, Ontario, CA' is Canada,
 * 'Berlin, Berlin, DE' is Germany. Keyed by the tail code. Only the codes
 * boards actually pair with a regional middle part are listed; anything not
 * listed falls back to the US-state reading.
 */
const NON_US_SUBDIVISIONS_BY_TAIL_CODE: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  CA: new Set([
    'alberta', 'ab', 'british columbia', 'bc', 'manitoba', 'mb',
    'new brunswick', 'nb', 'newfoundland', 'newfoundland and labrador', 'nl',
    'nova scotia', 'ns', 'ontario', 'on', 'prince edward island', 'pe', 'pei',
    'quebec', 'québec', 'qc', 'saskatchewan', 'sk', 'northwest territories',
    'nt', 'nunavut', 'nu', 'yukon', 'yt',
  ]),
  DE: new Set([
    'baden-württemberg', 'baden-wurttemberg', 'baden-wuerttemberg', 'bavaria',
    'bayern', 'berlin', 'brandenburg', 'bremen', 'hamburg', 'hesse', 'hessen',
    'lower saxony', 'niedersachsen', 'mecklenburg-vorpommern',
    'mecklenburg-western pomerania', 'north rhine-westphalia',
    'nordrhein-westfalen', 'rhineland-palatinate', 'rheinland-pfalz',
    'saarland', 'saxony', 'sachsen', 'saxony-anhalt', 'sachsen-anhalt',
    'schleswig-holstein', 'thuringia', 'thüringen', 'thueringen',
  ]),
  IN: new Set([
    'andhra pradesh', 'assam', 'bihar', 'chandigarh', 'chhattisgarh', 'delhi',
    'new delhi', 'nct', 'national capital territory of delhi', 'goa',
    'gujarat', 'haryana', 'himachal pradesh', 'jammu and kashmir', 'jharkhand',
    'karnataka', 'kerala', 'madhya pradesh', 'maharashtra', 'odisha', 'orissa',
    'puducherry', 'punjab', 'rajasthan', 'tamil nadu', 'tamilnadu', 'telangana',
    'uttar pradesh', 'uttarakhand', 'west bengal',
  ]),
  IL: new Set([
    'tel aviv', 'tel aviv district', 'tel aviv-yafo', 'jerusalem',
    'jerusalem district', 'haifa', 'haifa district', 'center district',
    'central district', 'northern district', 'southern district',
    // district names as boards print them without 'District'
    // ('Petah Tikva, Central, IL') — consulted only for an 'IL' tail
    'central', 'center', 'northern', 'southern', 'judea and samaria',
  ]),
  CO: new Set([
    'antioquia', 'atlántico', 'atlantico', 'bogotá', 'bogota', 'bogotá d.c.',
    'bogota d.c.', 'bogotá dc', 'bogota dc', 'distrito capital', 'bolívar',
    'bolivar', 'cundinamarca', 'santander', 'valle del cauca', 'risaralda',
    'caldas',
  ]),
  AR: new Set([
    'buenos aires', 'caba', 'ciudad autónoma de buenos aires',
    'ciudad autonoma de buenos aires', 'córdoba', 'cordoba', 'mendoza',
    'santa fe', 'tucumán', 'tucuman',
  ]),
  ID: new Set([
    'jakarta', 'dki jakarta', 'special capital region of jakarta', 'bali',
    'banten', 'west java', 'jawa barat', 'east java', 'jawa timur',
    'central java', 'jawa tengah', 'yogyakarta', 'north sumatra',
    'sumatera utara',
  ]),
  MA: new Set([
    'casablanca-settat', 'rabat-salé-kénitra', 'rabat-sale-kenitra',
    'marrakech-safi', 'fès-meknès', 'fes-meknes', 'tanger-tétouan-al hoceïma',
    'tanger-tetouan-al hoceima', 'grand casablanca',
  ]),
  PA: new Set(['panamá', 'panama', 'panamá oeste', 'panama oeste', 'colón', 'colon']),
  AE: new Set([
    'dubai', 'abu dhabi', 'sharjah', 'ajman', 'fujairah', 'ras al khaimah',
    'umm al quwain',
  ]),
};

/* ────────────────────────────────────────────────────────────────────── *
 *  Options and environment (fork-sync hardening, Spec 1689)
 * ────────────────────────────────────────────────────────────────────── */

/** Default cap on a label's length before heuristics are skipped. */
export const DEFAULT_MAX_LOCATION_LABEL_LENGTH = 256;

/** Environment variables that set the parser's process-wide defaults. */
export const LOCATION_PARSER_ENV = {
  /** Integer; a `;`/`|` site chunk longer than this is kept verbatim. 0 = no cap. Default 256. */
  maxLabelLength: 'EVER_JOBS_LOCATION_MAX_LABEL_LENGTH',
  /**
   * 'true' restores the legacy `{ city: 'Remote', country }` for remote-only
   * input. Default false (the fork's output) — an open owner decision, see
   * docs/questions.md; deployments that want the legacy output set it.
   */
  emitRemoteCity: 'EVER_JOBS_LOCATION_REMOTE_CITY',
  /** 'false' restores the legacy opt-in default of `allowBareStateProvince`. Default true. */
  allowBareStateProvince: 'EVER_JOBS_LOCATION_BARE_STATE',
  /** 'false' restores the ISO-country-first reading of ambiguous codes. Default true. */
  preferUsStateCode: 'EVER_JOBS_LOCATION_PREFER_US_STATE',
  /**
   * 'true' also reads a lone ambiguous code after a comma'd qualifier
   * ('Remote, CA', 'Hybrid, DE') as the US state. Default false (the country).
   */
  preferUsStateAfterQualifier: 'EVER_JOBS_LOCATION_PREFER_US_STATE_AFTER_QUALIFIER',
  /**
   * 'false' restores the configured-countries-only lookup (COUNTRY_CONFIG
   * names, alpha-2, the legacy alpha-3 list and its spellings). Default true:
   * every ISO 3166-1 country name and upper-case alpha-3 code (Spec 1699).
   */
  isoCountryNames: 'EVER_JOBS_LOCATION_ISO_COUNTRY_NAMES',
} as const;

interface ResolvedParseLocationOptions {
  readonly allowBareStateProvince: boolean;
  readonly emitRemoteCity: boolean;
  readonly preferUsStateCode: boolean;
  readonly preferUsStateAfterQualifier: boolean;
  readonly isoCountryNames: boolean;
  /** 0 = no cap */
  readonly maxLabelLength: number;
}

let cachedEnvDefaults: ResolvedParseLocationOptions | null = null;

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') {
    return false;
  }
  logger.warn(
    `Ignoring ${name}=${JSON.stringify(raw)} (expected true/false); using ${fallback}`,
  );
  return fallback;
}

function readLengthEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (Number.isInteger(value) && value >= 0) return value;
  logger.warn(
    `Ignoring ${name}=${JSON.stringify(raw)} (expected an integer >= 0); using ${fallback}`,
  );
  return fallback;
}

function envDefaults(): ResolvedParseLocationOptions {
  if (cachedEnvDefaults) return cachedEnvDefaults;
  cachedEnvDefaults = {
    allowBareStateProvince: readBooleanEnv(
      LOCATION_PARSER_ENV.allowBareStateProvince,
      true,
    ),
    emitRemoteCity: readBooleanEnv(LOCATION_PARSER_ENV.emitRemoteCity, false),
    preferUsStateCode: readBooleanEnv(
      LOCATION_PARSER_ENV.preferUsStateCode,
      true,
    ),
    preferUsStateAfterQualifier: readBooleanEnv(
      LOCATION_PARSER_ENV.preferUsStateAfterQualifier,
      false,
    ),
    isoCountryNames: readBooleanEnv(LOCATION_PARSER_ENV.isoCountryNames, true),
    maxLabelLength: readLengthEnv(
      LOCATION_PARSER_ENV.maxLabelLength,
      DEFAULT_MAX_LOCATION_LABEL_LENGTH,
    ),
  };
  return cachedEnvDefaults;
}

/**
 * Forget the cached environment defaults so the next parse re-reads
 * `EVER_JOBS_LOCATION_*`. The env is read once per process otherwise; tests
 * that change it call this before and after.
 */
export function resetLocationParserEnvCache(): void {
  cachedEnvDefaults = null;
}

/** Per-call options win; anything unset falls back to the env defaults. */
function resolveOptions(
  options?: ParseLocationOptions,
): ResolvedParseLocationOptions {
  const env = envDefaults();
  if (!options) return env;
  const cap = options.maxLabelLength;
  return {
    allowBareStateProvince:
      options.allowBareStateProvince ?? env.allowBareStateProvince,
    emitRemoteCity: options.emitRemoteCity ?? env.emitRemoteCity,
    preferUsStateCode: options.preferUsStateCode ?? env.preferUsStateCode,
    preferUsStateAfterQualifier:
      options.preferUsStateAfterQualifier ?? env.preferUsStateAfterQualifier,
    isoCountryNames: options.isoCountryNames ?? env.isoCountryNames,
    maxLabelLength:
      typeof cap === 'number' && Number.isFinite(cap) && cap >= 0
        ? Math.floor(cap)
        : env.maxLabelLength,
  };
}

/** Qualifier-flavored text is never a site name ('Hybrid possible', 'On-site'). */
const QUALIFIER_WORD_RE =
  /\b(?:hybrid|remote|on-?site|offsite|telecommut\w*|work\s+from\s+home|wfh)\b/i;
const asSiteName = (v: string | null | undefined): string | undefined =>
  v && !QUALIFIER_WORD_RE.test(v) ? v : undefined;

/**
 * Tail words that identify a site descriptor rather than a subdivision —
 * 'Mytra, Inc.', 'Chicago, IL - Atlas', 'Plant 4'.
 */
const SITE_DESCRIPTOR_RE =
  /\b(?:hq|hqtrs|headquarters|office|campus|corp(?:orate)?|site|plant|services|pvt|ltd|inc|factory|facility|works|on-?site|onsite|offsite)\b/i;

/**
 * Street-suffix tail words ('Gaither Rd.', 'Pennsylvania Avenue') — used
 * ONLY inside a 'ST - X' dash suffix to tell a site/street name (→ `name`)
 * from a city (→ `city`). Never applied to comma tails, so 'Warsaw, PL'
 * still reads PL as Poland.
 */
const STREET_SUFFIX_RE =
  /\b(?:st|street|rd|road|ave|avenue|blvd|dr|drive|ln|lane|ct|pkwy|hwy|way|cir|pl)\.?$/i;

/**
 * 'Rockville Corp Hqtrs' → { city: 'Rockville', name: 'Corp Hqtrs' } — the
 * longest tail whose words are all site descriptors becomes `name`, the
 * rest `city`. Returns null for a plain city ('Rockville').
 */
function splitCityDescriptor(
  only: string,
): { city: string; name: string } | null {
  const words = only.split(/\s+/);
  // first index from which every word to the end is a descriptor — O(n),
  // instead of re-testing every tail per cut
  let firstDescriptor = words.length;
  while (
    firstDescriptor > 0 &&
    SITE_DESCRIPTOR_RE.test(words[firstDescriptor - 1])
  ) {
    firstDescriptor--;
  }
  // the shortest city prefix wins; a longer prefix only adds characters, so
  // if the shortest one is not a bare-city candidate no longer one is either
  const cut = Math.max(1, firstDescriptor);
  if (cut >= words.length) return null;
  const city = words.slice(0, cut).join(' ');
  if (!isBareCityCandidate(city)) return null;
  return { city, name: words.slice(cut).join(' ') };
}

/** Every word is a site descriptor ('Corp Hqtrs', 'HQ') — a site, not a city. */
function isSiteDescriptorOnly(only: string): boolean {
  const words = only.split(/\s+/);
  return words.length > 0 && words.every((w) => SITE_DESCRIPTOR_RE.test(w));
}

type WorkFromHomeType = 'Hybrid' | 'Remote' | 'Hybrid or Remote';

export interface ParsedLocationText {
  location: LocationDto | null;
  remoteMentioned: boolean;
  workFromHomeType: WorkFromHomeType | null;
}

export interface ParsedLocationList {
  location: LocationDto | null;
  locations: LocationDto[];
  labels: string[];
  remoteMentioned: boolean;
  workFromHomeType: WorkFromHomeType | null;
}

/**
 * Per-call parser options. Every field is optional; an unset field takes the
 * process-wide default from its `EVER_JOBS_LOCATION_*` env var (read once,
 * see {@link LOCATION_PARSER_ENV} / {@link resetLocationParserEnvCache}).
 */
export interface ParseLocationOptions {
  /**
   * When false, a lone token that exactly matches a known US state/territory
   * **name** or **2-letter code** stays in the `city` field. Defaults to true:
   * a bare `"Virginia"` / `"VA"` resolves to `{ state: 'VA' }`. Names colliding
   * with prominent cities ('Washington', 'New York', 'Georgia') are exempt and
   * remain cities. Named generically (state/province) so the flag can later
   * cover non-US subdivisions without another signature change.
   *
   * Env default: `EVER_JOBS_LOCATION_BARE_STATE` (default true; `false`
   * restores the pre-fork opt-in behaviour for every caller).
   */
  allowBareStateProvince?: boolean;
  /**
   * When true, remote-only input with no concrete site ('Remote',
   * ['Remote', 'United States'], 'Remote - US') yields the legacy
   * `{ city: 'Remote', country }` as the merged `location` — the pre-fork
   * parser's output, which REST, GraphQL `location { city }` and MCP
   * consumers read 'Remote' from. False (the default) is the fork's reading:
   * qualifiers live in the flags (`remoteMentioned` / `workFromHomeType`)
   * only and no city is minted. `locations[]` is unaffected either way, and
   * so is the canonical key (its remote bucket reads `isRemote`).
   *
   * The default is the fork's because 79 fork plugin spec files pin it, and
   * neither value reproduces develop 574bd922 for the ~940 plugins the fork
   * migrated onto this parser (they emitted the raw label, e.g. 'Remote - US',
   * as the city). Kept open for the owner in docs/questions.md.
   *
   * Env default: `EVER_JOBS_LOCATION_REMOTE_CITY` (default false).
   */
  emitRemoteCity?: boolean;
  /**
   * How a 2-letter code that is BOTH a US state and an ISO country ('CA',
   * 'IL', 'CO', 'IN', 'DE', …) reads where the fork read it as a country:
   * the tail of a 3+-part label ('Downtown, Los Angeles, CA'), 'Remote in CO',
   * 'Remote - CO' and 'Remote CO'. Default true = US state, unless the label
   * carries a non-US signal: a middle part naming a non-US country, a known
   * subdivision of the code's country ('Toronto, Ontario, CA'), a bare
   * short region code in a middle part ('Bengaluru, KA, IN',
   * 'Cologne, NW, DE', 'Chennai, TN, IN' — a US label names one state), or
   * a first part naming the code's own country
   * ('Colombia, Medellín, CO'). A city named after another country stays US
   * ('Peru, Miami County, IN'). False restores the fork's ISO-country-first
   * reading.
   *
   * Env default: `EVER_JOBS_LOCATION_PREFER_US_STATE` (default true).
   */
  preferUsStateCode?: boolean;
  /**
   * Also read a lone ambiguous code left after a comma'd qualifier
   * ('Remote, CA', 'Hybrid, DE', 'Remote, IN') as the US state — like a bare
   * 'CA' label — instead of the country (Canada / Germany / India, the
   * fork's reading). Only consulted when `preferUsStateCode` is on.
   *
   * Env default: `EVER_JOBS_LOCATION_PREFER_US_STATE_AFTER_QUALIFIER`
   * (default false).
   */
  preferUsStateAfterQualifier?: boolean;
  /**
   * Recognise EVERY ISO 3166-1 country in a country slot, not only the
   * configured `COUNTRY_CONFIG` markets (Spec 1699): its CLDR name and common
   * board spellings ('Colombo, Western Province, Sri Lanka', 'Almaty,
   * Kazakhstan', 'Abidjan, Ivory Coast'), and its alpha-3 code as an
   * upper-case token ('Colombo, LKA'). A country's name, alpha-2 and alpha-3
   * then canonicalise to one display name ('CZE' / 'CZ' / 'Czechia' ->
   * 'Czechia'). Guards keep US readings: a US town named after a country
   * ('Lebanon, PA', 'Peru, Miami County, IN'), US territories ('San Juan,
   * Puerto Rico') and the state 'Georgia' ('Tbilisi, Georgia' is the country
   * only next to a Georgian place). False restores the configured-only
   * lookup and the legacy alpha-3 spellings ('CZE' -> 'Czech Republic').
   *
   * Env default: `EVER_JOBS_LOCATION_ISO_COUNTRY_NAMES` (default true).
   */
  isoCountryNames?: boolean;
  /**
   * A site chunk (one `;`/`|`-separated piece of a label, after whitespace
   * collapsing) longer than this many characters skips every heuristic and is
   * kept verbatim as one entry (`{ text, name }`), which bounds the per-chunk
   * CPU on hostile or runaway input. Applied per chunk, not to the whole
   * label, so a long multi-site list ('Austin, TX; Denver, CO; …') keeps its
   * structured sites. 0 = no cap.
   *
   * Env default: `EVER_JOBS_LOCATION_MAX_LABEL_LENGTH` (default 256).
   */
  maxLabelLength?: number;
}

function countryDisplay(country: Country): string | null {
  try {
    const code = getIndeedDomain(country).apiCountryCode;
    const name = regionNameFromCode(code);
    if (name) return name;
  } catch {
    /* fall through */
  }
  const first = (COUNTRY_CONFIG[country]?.names ?? '').split(',')[0].trim();
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * COUNTRY_CONFIG name/alias -> display name, built once at module load.
 * Mirrors `countryFromString` exactly (same keys, first configured country
 * wins) without its throw-on-miss path, which cost ~70 µs per miss and ran
 * several times per label. `null` marks a configured name with no display.
 */
const COUNTRY_NAME_DISPLAY: ReadonlyMap<string, string | null> = (() => {
  const map = new Map<string, string | null>();
  for (const country of Object.keys(COUNTRY_CONFIG) as Country[]) {
    const display = countryDisplay(country);
    for (const name of COUNTRY_CONFIG[country].names.split(',')) {
      if (!map.has(name)) map.set(name, display);
    }
  }
  return map;
})();

/** Memoized `regionNameFromCode` for upper-case alpha-2 codes (≤ 676 keys). */
const REGION_NAME_CACHE = new Map<string, string | null>();

function regionNameCached(code: string): string | null {
  let name = REGION_NAME_CACHE.get(code);
  if (name === undefined) {
    name = regionNameFromCode(code);
    REGION_NAME_CACHE.set(code, name);
  }
  return name;
}

/* ────────────────────────────────────────────────────────────────────── *
 *  Every ISO 3166-1 country (Spec 1699)
 * ────────────────────────────────────────────────────────────────────── */

/** 'Côte d’Ivoire' -> "Cote d'Ivoire": strip combining marks, unify apostrophes. */
function foldCountryKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[\u2018\u2019\u02bc]/g, "'");
}

/** Any non-ASCII character — only such input needs the diacritic fold. */
const NON_ASCII_RE = /[\u0080-\uffff]/;

/**
 * Display names for the few CLDR names that would not survive a re-parse of
 * an emitted label: ' - ' reads as a site suffix ('Congo - Kinshasa') and
 * parentheses as a qualifier ('Myanmar (Burma)'). Every other country is
 * emitted exactly as CLDR spells it.
 */
const ISO_DISPLAY_OVERRIDES: Readonly<Record<string, string>> = {
  CD: 'DR Congo',
  CG: 'Republic of the Congo',
  MM: 'Myanmar',
};

/**
 * Spellings boards use that CLDR does not produce (keys lower-case, dots
 * removed, diacritics folded) -> alpha-2.
 */
const ISO_NAME_ALIASES: Readonly<Record<string, string>> = {
  'ivory coast': 'CI',
  'democratic republic of the congo': 'CD',
  'democratic republic of congo': 'CD',
  'congo-kinshasa': 'CD',
  'congo kinshasa': 'CD',
  drc: 'CD',
  'republic of the congo': 'CG',
  'republic of congo': 'CG',
  'congo-brazzaville': 'CG',
  'congo brazzaville': 'CG',
  burma: 'MM',
  macedonia: 'MK',
  swaziland: 'SZ',
  'east timor': 'TL',
  'timor leste': 'TL',
  'guinea bissau': 'GW',
  vatican: 'VA',
  'holy see': 'VA',
  palestine: 'PS',
  'state of palestine': 'PS',
  'russian federation': 'RU',
  'viet nam': 'VN',
  'lao pdr': 'LA',
  macau: 'MO',
  'macao sar': 'MO',
  'macau sar': 'MO',
  'hong kong sar': 'HK',
  'cabo verde': 'CV',
  'the bahamas': 'BS',
  'the gambia': 'GM',
  'the netherlands': 'NL',
  'the philippines': 'PH',
  'brunei darussalam': 'BN',
  'syrian arab republic': 'SY',
  'kyrgyz republic': 'KG',
  'republic of korea': 'KR',
  'united states of america': 'US',
  'great britain': 'GB',
  'saint vincent and the grenadines': 'VC',
  'st vincent and the grenadines': 'VC',
  'cocos islands': 'CC',
  bonaire: 'BQ',
};

/**
 * Codes whose NAME never reads as a country: US territories stay US
 * subdivisions ('San Juan, Puerto Rico'), and 'Georgia' is a US state far
 * more often than the country (GEORGIA_COUNTRY_PLACES decides). Their codes
 * still resolve ('Tbilisi, GE').
 */
const ISO_NAME_EXCLUDED = new Set(['AS', 'GE', 'GU', 'MP', 'PR', 'UM', 'VI']);

/**
 * Upper-case alpha-3 codes that are everyday words, abbreviations or airport
 * codes before they are a country ('AND', 'MAC', 'VAT', 'IOT', 'ETH', 'NAM',
 * 'MCO', 'ALA'), plus the US territories. Never read as a country outside the
 * legacy configured list.
 */
const ALPHA3_AMBIGUOUS = new Set([
  'ALA', 'AND', 'ARM', 'ASM', 'ATF', 'BEN', 'BLM', 'BTN', 'CAF', 'CIV', 'COD',
  'COM', 'DJI', 'DMA', 'DOM', 'ETH', 'GEO', 'GIN', 'GTM', 'GUM', 'GUY', 'IOT',
  'JAM', 'KEN', 'LCA', 'MAC', 'MCO', 'MNP', 'NAM', 'PNG', 'PRI', 'SDN', 'SEN',
  'SSD', 'SUR', 'TLS', 'TON', 'TUV', 'UGA', 'UMI', 'VAT', 'VIR',
]);

/** The emitted display name of an ISO alpha-2 code (CLDR, bar the overrides). */
function isoDisplay(alpha2: string): string | null {
  return ISO_DISPLAY_OVERRIDES[alpha2] ?? regionNameCached(alpha2);
}

/**
 * Every lookup key one CLDR name yields: '&' <-> 'and', 'St.' -> 'Saint',
 * 'X (Y)' -> X, Y and 'X Y' (the parser keeps non-qualifier parenthesised
 * text inline), 'X SAR China' -> X.
 */
function isoNameKeys(name: string): string[] {
  const base = foldCountryKey(name.toLowerCase()).replace(/\./g, '').trim();
  const keys = new Set<string>([base, base.replace(/ & /g, ' and ')]);
  for (const key of [...keys]) {
    if (key.startsWith('st ')) keys.add(`saint ${key.slice(3)}`);
  }
  for (const key of [...keys]) {
    if (key.includes('(')) {
      keys.add(key.replace(/[()]/g, ''));
      const paren = /^([^()]+) \(([^()]+)\)$/.exec(key);
      if (paren) {
        keys.add(paren[1]);
        keys.add(paren[2]);
      }
    }
    if (key.endsWith(' sar china')) keys.add(key.slice(0, -' sar china'.length));
  }
  return [...keys];
}

/**
 * Lower-case, dot-less, diacritic-folded country name -> display name for
 * every ISO 3166-1 country the runtime's CLDR data knows (~250 countries,
 * ~300 keys), built once at module load. Consulted AFTER
 * COUNTRY_NAME_DISPLAY, so configured names keep their display.
 */
const ISO_COUNTRY_NAME_DISPLAY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const add = (key: string, display: string) => {
    if (!map.has(key)) map.set(key, display);
  };
  for (const alpha2 of Object.keys(ISO_ALPHA2_TO_ALPHA3)) {
    if (ISO_NAME_EXCLUDED.has(alpha2)) continue;
    const cldr = regionNameCached(alpha2);
    const display = isoDisplay(alpha2);
    if (!cldr || !display) continue;
    for (const key of [...isoNameKeys(cldr), ...isoNameKeys(display)]) {
      add(key, display);
    }
  }
  for (const [alias, alpha2] of Object.entries(ISO_NAME_ALIASES)) {
    const display = isoDisplay(alpha2);
    if (display) add(alias, display);
  }
  return map;
})();

/**
 * Longest country-name lookup key, plus slack for the dots and combining
 * marks a raw label may still carry — a longer text is never a country name.
 */
const MAX_COUNTRY_NAME_LENGTH =
  Math.max(
    ...[...ISO_COUNTRY_NAME_DISPLAY.keys(), ...COUNTRY_NAME_DISPLAY.keys()].map(
      (key) => key.length,
    ),
  ) + 16;

/** An ISO country by name ('sri lanka', 'côte d’ivoire'); `key` is lower-case, dot-less. */
function isoCountryByName(key: string): string | null {
  return (
    ISO_COUNTRY_NAME_DISPLAY.get(key) ??
    (NON_ASCII_RE.test(key)
      ? ISO_COUNTRY_NAME_DISPLAY.get(foldCountryKey(key))
      : undefined) ??
    null
  );
}

/**
 * A country by NAME only — configured names and aliases, then (with `iso`)
 * every ISO name. Never a code: 'GA - Remote' keeps 'GA' as the state.
 */
function countryByNameOnly(value: string, iso: boolean): string | null {
  const key = value.trim().toLowerCase();
  const configured = COUNTRY_NAME_DISPLAY.get(key);
  if (configured !== undefined) return configured;
  return iso ? isoCountryByName(key.replace(/\./g, '')) : null;
}

/**
 * Recognize a country token in country-slot context. `iso` = the
 * `isoCountryNames` option (Spec 1699); false is the pre-1699 lookup.
 */
function normalizeCountryWith(value: string, iso: boolean): string | null {
  const normalized = value.trim().toLowerCase().replace(/\./g, '');
  if (!normalized) return null;
  if (normalized === 'korea') return 'South Korea';
  const display = COUNTRY_NAME_DISPLAY.get(normalized);
  if (display) return display;
  if (iso) {
    const byName = isoCountryByName(normalized);
    if (byName) return byName;
  }
  if (/^[a-z]{2}$/.test(normalized)) {
    const upper = normalized.toUpperCase();
    // the overrides keep 'CD' / 'DR Congo' on one spelling
    const name = iso ? isoDisplay(upper) : regionNameCached(upper);
    if (name) return name;
  }
  if (/^[a-z]{3}$/.test(normalized)) {
    const upper = normalized.toUpperCase();
    const legacy = COUNTRY_ALPHA3[upper];
    if (!iso) return legacy ?? null;
    if (legacy) {
      // legacy codes stay case-insensitive; their NAME now comes from the
      // same display path as every other form, so 'CZE' and 'Czechia' agree
      const alpha2 = upper === 'UAE' ? 'AE' : ISO_ALPHA3_TO_ALPHA2[upper];
      return (alpha2 && isoDisplay(alpha2)) || legacy;
    }
    // the rest of ISO alpha-3 only as an upper-case token ('Colombo, LKA'),
    // never an everyday word ('AND', 'MAC') or a US territory
    const raw = value.trim().replace(/\./g, '');
    if (raw === upper && !ALPHA3_AMBIGUOUS.has(upper)) {
      const alpha2 = ISO_ALPHA3_TO_ALPHA2[upper];
      if (alpha2) return isoDisplay(alpha2);
    }
  }
  return null;
}

/** 'Tbilisi' / 'Kvemo Kartli' — a part naming a Georgian city or region. */
function isGeorgianPlace(part: string): boolean {
  const key = part.trim().toLowerCase();
  return GEORGIA_COUNTRY_PLACES.has(
    NON_ASCII_RE.test(key) ? foldCountryKey(key) : key,
  );
}

/** `normalizeCountryWith` under the resolved per-call options. */
function countryIn(
  value: string,
  opts: ResolvedParseLocationOptions,
): string | null {
  return normalizeCountryWith(value, opts.isoCountryNames);
}

/**
 * Recognize a country token in country-slot context: COUNTRY_CONFIG names and
 * aliases, ISO alpha-2, alpha-3, and the pragmatic `'korea'` alias (job
 * boards mean South Korea). With `isoCountryNames` (the default, see
 * {@link ParseLocationOptions.isoCountryNames}) also every ISO 3166-1 country
 * name and upper-case alpha-3 code.
 */
export function normalizeCountryOnly(
  value: string,
  options?: Pick<ParseLocationOptions, 'isoCountryNames'>,
): string | null {
  return normalizeCountryWith(
    value,
    options?.isoCountryNames ?? envDefaults().isoCountryNames,
  );
}

/**
 * One canonical display name for a country value in ANY of the forms sources
 * use — config names/aliases ('usa', 'united states'), ISO alpha-2 ('US'),
 * alpha-3 ('USA', 'GBR') and `Country` enum keys ('UNITEDARABEMIRATES').
 * Returns null when the value is not recognizably a country. Used to make
 * dedup keys agree across sources ('USA' / 'US' / 'United States').
 */
export function canonicalCountryName(
  value: string | null | undefined,
  options?: Pick<ParseLocationOptions, 'isoCountryNames'>,
): string | null {
  if (!value) return null;
  const byName = normalizeCountryOnly(value, options);
  if (byName) return byName;
  const key = value.trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(COUNTRY_CONFIG, key)) {
    return countryDisplay(key as Country);
  }
  return null;
}

/** 'CA' / 'il' — a 2-letter token that is a US state/territory code. */
function isUsStateCodeToken(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^[A-Za-z]{2}$/.test(trimmed) &&
    US_STATE_AND_TERRITORY_CODES.has(trimmed.toUpperCase())
  );
}

const US_COUNTRY_DISPLAY = 'United States';

/** A short ALL-CAPS token — the shape of a regional code ('KA', 'NW', 'ANT'). */
const SHORT_REGION_CODE_RE = /^[A-Z]{2,3}$/;

/**
 * A bare short ALL-CAPS region code in a MIDDLE part, before an ambiguous tail
 * code. A US 'City, County, ST' label never has one: it would be a foreign
 * region ('Bengaluru, KA, IN', 'Cologne, NW, DE', 'Medellin, ANT, CO') or a
 * second state-shaped code ('Chennai, TN, IN' — Tamil Nadu, not Tennessee,
 * since a US label names one state). Names for the US ('USA') and site
 * descriptors ('HQ') are not region codes.
 */
function isMiddleRegionCode(
  part: string,
  opts: ResolvedParseLocationOptions,
): boolean {
  const trimmed = part.trim();
  return (
    SHORT_REGION_CODE_RE.test(trimmed) &&
    countryIn(trimmed, opts) !== US_COUNTRY_DISPLAY &&
    !SITE_DESCRIPTOR_RE.test(trimmed)
  );
}

/**
 * US-state-first check for an ambiguous tail code ('CA', 'IL', 'CO', …) in a
 * 'City, Middle…, XX' label (`others` = every part before the tail). The
 * state reading wins unless the label carries a non-US signal:
 *  - any part is a known subdivision of the code's country
 *    ('Toronto, Ontario, CA', 'Berlin, Berlin, DE');
 *  - a middle part names a non-US country ('Haifa, Israel, IL');
 *  - a middle part is a bare short regional code
 *    ('Bengaluru, KA, IN', 'Cologne, NW, DE', 'Chennai, TN, IN');
 *  - the first part names the code's own country ('Colombia, Medellín, CO').
 * The first part is otherwise the city slot, and a US city may be named after
 * another country, so it never vetoes on its own: 'Peru, Miami County, IN' and
 * 'Mexico, Audrain County, MO' stay Indiana / Missouri.
 */
function usStateTailWins(
  tail: string,
  others: readonly string[],
  opts: ResolvedParseLocationOptions,
): boolean {
  const code = tail.trim().toUpperCase();
  const pinned = NON_US_SUBDIVISIONS_BY_TAIL_CODE[code];
  const tailCountry = countryIn(code, opts);
  for (let i = 0; i < others.length; i++) {
    const part = others[i];
    if (pinned?.has(part.trim().toLowerCase())) return false;
    const named = countryIn(part, opts);
    if (i === 0) {
      if (named && named === tailCountry) return false;
      continue;
    }
    if (named && named !== US_COUNTRY_DISPLAY) return false;
    if (isMiddleRegionCode(part, opts)) return false;
  }
  return true;
}

export function normalizeUsState(value: string): string | null {
  const trimmed = value.trim();
  // periods are decorative in state codes: 'D.C.' -> 'DC', 'N.Y.' -> 'NY'
  const code = trimmed.toUpperCase().replace(/\./g, '');
  if (US_STATE_AND_TERRITORY_CODES.has(code)) return code;
  return US_STATE_NAME_TO_CODE[trimmed.toLowerCase()] ?? null;
}

/** US state (code or name, emitted as code) or territory display name. */
function usSubdivision(value: string): string | null {
  return (
    normalizeUsState(value) ??
    US_TERRITORY_NAMES[value.trim().toLowerCase()] ??
    null
  );
}

/**
 * 'Bristol RI' / 'San Juan PR' / 'Washington D.C' — a space-joined label
 * ending in a US state code with a title-case city prefix. Returns null
 * when the last token isn't a code (territory names are multi-word and are
 * caught by usSubdivision before this runs).
 */
function bareLabelWithStateSuffix(
  only: string,
): { city: string; state: string } | null {
  // `(?<!\s)`: split at the head of the last whitespace run (same match as
  // the lazy group alone, without rescanning a long run per position)
  const m = /^(.+?)(?<!\s)\s+([A-Za-z.]{2,6})$/.exec(only.trim());
  if (!m) return null;
  const st = normalizeUsState(m[2]);
  if (!st || !isBareCityCandidate(m[1])) return null;
  return { city: m[1].trim(), state: st };
}

/**
 * True when a segment is workplace text only — 'Remote', 'Hybrid / Remote',
 * 'Remote and onsite'. 'and'/'or' are filler words but never an ALL-CAPS
 * 2-letter state code ('OR' is Oregon, not a connector).
 */
function isWorkplaceQualifierOnly(value: string, allowSlash: boolean): boolean {
  if (!/\b(?:hybrid|remote)\b/i.test(value)) return false;
  const withoutWords = value
    .replace(/\b(?:hybrid|remote)\b/gi, '')
    .replace(/\b(?:and|or)\b/gi, (w) => (/^[A-Z]{2}$/.test(w) ? w : ' '));
  const allowedSeparators = allowSlash ? /^[\s/&,+-]*$/ : /^[\s&,+-]*$/;
  return allowedSeparators.test(withoutWords);
}

function remoteFlags(normalized: string): {
  remoteMentioned: boolean;
  workFromHomeType: WorkFromHomeType | null;
} {
  const remoteMentioned = /\bremote\b/i.test(normalized);
  const hybridMentioned = /\bhybrid\b/i.test(normalized);
  return {
    remoteMentioned,
    workFromHomeType: hybridMentioned
      ? remoteMentioned
        ? 'Hybrid or Remote'
        : 'Hybrid'
      : remoteMentioned
        ? 'Remote'
        : null,
  };
}

/** Qualifier affixes joined to geography without spaces ('Hybrid- Fremont'). */
const QUALIFIER_PREFIX_RE =
  /^(?:hybrid|remote|onsite|on-site|offsite|any office)\b\s*[-–—]\s*/i;
// `(?<!\s)` starts a match only at the head of a whitespace run, so a long
// run (e.g. from stripped '(1)' serial markers) is scanned once, not once
// per position — same matches as without it, linear instead of quadratic
const QUALIFIER_SUFFIX_RE =
  /(?<!\s)\s*[-–—]\s*(?:remote|hybrid|onsite|on-site|offsite)\b\s*$/i;

/** One character of the separators trimmed from a chunk's edges. */
const EDGE_SEPARATOR_CHAR_RE = /[\s/&|;,]/;

/**
 * Trim separator runs from both ends. Index-based: the former
 * `/^[…]+|[…]+$/g` replace rescanned a trailing run from every position
 * (quadratic — 20k chars of '/ ' took ~0.6 s).
 */
function trimEdgeSeparators(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && EDGE_SEPARATOR_CHAR_RE.test(s[start])) start++;
  while (end > start && EDGE_SEPARATOR_CHAR_RE.test(s[end - 1])) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

function affixStrip(s: string): string {
  return trimEdgeSeparators(
    s.replace(QUALIFIER_PREFIX_RE, '').replace(QUALIFIER_SUFFIX_RE, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reduce a raw label to its geographic core:
 *  - '(N)' serial markers removed
 *  - 'Hybrid (Clarksburg, MD, US)' / 'Remote (Paris, FR)' — when the text
 *    outside parens is workplace words, the paren content is the geo part
 *  - qualifier parens like '(Remote)' removed
 */
function extractGeo(normalized: string): string {
  const noSerial = normalized.replace(/\(\d+\)/g, ' ');
  const parens = [...noSerial.matchAll(/\(([^()]*)\)/g)];
  if (parens.length === 0) return affixStrip(noSerial);

  const outside = noSerial
    .replace(/\([^()]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const outsideQualifierish =
    isWorkplaceQualifierOnly(outside, true) ||
    /^(?:hybrid|remote|any|office|on-?site|offsite|onsite)[\s\-–—:]*$/i.test(
      outside,
    ) ||
    /^(?:hybrid|remote)[\s\-–—]+(?:any\s+)?office[\s\-–—:]*$/i.test(outside);

  const contents = parens.map((m) => m[1].trim()).filter(Boolean);
  const geoContents = contents.filter(
    (c) => !isWorkplaceQualifierOnly(c, true),
  );
  if (outsideQualifierish && geoContents.length) {
    return geoContents.join(', ');
  }
  // keep non-qualifier parens inline (they may carry part of the name)
  const kept = noSerial.replace(/\(([^()]*)\)/g, (whole, content: string) =>
    isWorkplaceQualifierOnly(content, true) ? ' ' : content,
  );
  // unspaced qualifier affixes: 'Hybrid- Fremont, CA', 'Texas-Remote'
  return affixStrip(kept);
}

interface SingleParse {
  location: LocationDto;
  /** carries state or country — structural evidence the parse found geo */
  firm: boolean;
  /** merged-blob label: input minus any literal country segment */
  blob?: string;
}

const REMOTE_HEAD_RE = /^(?:remote|hybrid)\b/i;
/** longest prefix of the characters the legacy middle group could consume */
const REMOTE_IN_MIDDLE_RE = /^[\s\w-]*/;
/** an ' in ' separator starting at the head of its whitespace run */
const REMOTE_IN_SEPARATOR_RE = /(?<!\s)\s+in\s+/gi;
const WORD_CHAR_RE = /\w/;
// built from a string: some transpilers emit a raw U+2028 inside a regex
// literal, which JS parses as a line break
const LINE_TERMINATOR_RE = new RegExp('[\\n\\r\\u2028\\u2029]');

/**
 * 'Remote in <geo>' / 'Hybrid - full time in <geo>' — returns `<geo>` or null.
 *
 * Linear-time equivalent of the fork's
 * `/^(?:remote|hybrid)\b(?:[\s-]*\w+)*?\s+in\s+(.+)$/i`, whose nested
 * quantifier split every run of word characters 2^(n-1) ways when there was
 * no ' in ' (a 53-char 'Remote …' label ran past 60 s). Same matches: the
 * middle between the qualifier and ' in ' may only hold word characters,
 * whitespace and '-', must end on a word character (or be empty), and the
 * EARLIEST such ' in ' wins. Exported for its differential test.
 */
export function matchRemoteInGeo(cleaned: string): string | null {
  const head = REMOTE_HEAD_RE.exec(cleaned);
  if (!head) return null;
  const rest = cleaned.slice(head[0].length);
  const middleLimit = REMOTE_IN_MIDDLE_RE.exec(rest)?.[0].length ?? 0;
  // the legacy `(.+)$` cannot cross a line terminator ('.' excludes it): a
  // capture must start after the last one
  let lastTerminator = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (LINE_TERMINATOR_RE.test(rest[i])) {
      lastTerminator = i;
      break;
    }
  }
  const separator = new RegExp(REMOTE_IN_SEPARATOR_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = separator.exec(rest))) {
    // candidates may overlap ('- in in X': the 2nd ' in ' reuses the 1st
    // one's trailing space), so resume one past this candidate's start
    separator.lastIndex = m.index + 1;
    // the middle rest[0, index) must lie inside the allowed-character prefix
    if (m.index > middleLimit) return null;
    if (m.index !== 0 && !WORD_CHAR_RE.test(rest[m.index - 1])) continue;
    const geoStart = m.index + m[0].length;
    if (geoStart < rest.length) {
      if (geoStart > lastTerminator) return rest.slice(geoStart);
      continue;
    }
    // untrimmed tail ('Remote in  '): like the legacy `\s+(.+)$`, the
    // trailing run gives its last character to the capture when it can
    const trailing = m[0].length - m[0].trimEnd().length;
    if (trailing >= 2 && geoStart - 1 > lastTerminator) return m[0].slice(-1);
  }
  return null;
}

/**
 * The geo after a 'Remote in' / 'Remote -' qualifier. With
 * `preferUsStateCode`, a US-state code ('Remote in CO') reads as the state
 * before the ISO-country lookup (Colombia), and a full state name
 * ('Remote in Texas') resolves to its code. Without it: country only (the
 * fork's reading).
 */
function remoteQualifiedGeo(
  geo: string,
  opts: ResolvedParseLocationOptions,
): LocationDto | null {
  const trimmed = geo.trim();
  if (opts.preferUsStateCode && isUsStateCodeToken(trimmed)) {
    return new LocationDto({ state: trimmed.toUpperCase() });
  }
  const c = countryIn(trimmed, opts);
  if (c) return new LocationDto({ country: c });
  if (
    opts.preferUsStateCode &&
    !BARE_STATE_NAME_COLLISIONS.has(trimmed.toLowerCase())
  ) {
    const st = usSubdivision(trimmed);
    if (st) return new LocationDto({ state: st });
  }
  return null;
}

/** Parse ONE clean label into a geographic entry. Right-to-left consumption. */
function parseSingleLabel(
  cleaned: string,
  opts: ResolvedParseLocationOptions,
): SingleParse | null {
  if (!cleaned) return null;

  // 'Remote in <country>' / 'Remote - <country>'
  const remoteIn = matchRemoteInGeo(cleaned);
  if (remoteIn !== null) {
    const loc = remoteQualifiedGeo(remoteIn, opts);
    if (loc) return { location: loc, firm: true };
  }
  const remoteDash = /^(?:remote|hybrid)\s*[-–—]\s*(.+)$/i.exec(cleaned);
  if (remoteDash) {
    const loc = remoteQualifiedGeo(remoteDash[1], opts);
    if (loc) return { location: loc, firm: true };
  }

  // 'Remote United States' / 'Hybrid Austin' — qualifier word fused with a
  // country or US state: drop the word, keep the geo
  const fused = /^(?:remote|hybrid|onsite|on-site|offsite)\s+(.+)$/i.exec(
    cleaned,
  );
  if (fused) {
    const geo = fused[1].trim();
    // 'Remote CA' — an ambiguous code reads as the US state first
    if (opts.preferUsStateCode && isUsStateCodeToken(geo)) {
      return {
        location: new LocationDto({ state: geo.toUpperCase() }),
        firm: true,
      };
    }
    const c = countryIn(geo, opts);
    if (c) return { location: new LocationDto({ country: c }), firm: true };
    const st = usSubdivision(geo);
    if (st) return { location: new LocationDto({ state: st }), firm: true };
  }

  // whole-label country (a bare 2-letter US-state code prefers the state read)
  const wholeCountry = countryIn(cleaned, opts);
  if (wholeCountry) {
    const bareState = /^[A-Za-z]{2}$/.test(cleaned.trim())
      ? normalizeUsState(cleaned)
      : null;
    if (bareState) {
      if (!opts.allowBareStateProvince) {
        return { location: new LocationDto({ city: cleaned }), firm: false };
      }
      return {
        location: new LocationDto({ state: bareState }),
        firm: true,
      };
    }
    return { location: new LocationDto({ country: wholeCountry }), firm: true };
  }

  const parts = cleaned
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  if (parts.length === 1 && !cleaned.includes(' - ')) {
    const only = parts[0];
    if (opts.allowBareStateProvince) {
      if (!BARE_STATE_NAME_COLLISIONS.has(only.toLowerCase())) {
        const bareState = usSubdivision(only);
        if (bareState) {
          return {
            location: new LocationDto({ state: bareState }),
            firm: true,
          };
        }
      }
      const split = bareLabelWithStateSuffix(only);
      if (split) {
        return {
          location: new LocationDto({ city: split.city, state: split.state }),
          firm: true,
          blob: only,
        };
      }
      // 'MA-Boston' unspaced — a US-state code prefix claims `state`;
      // the title-case rest is a site name on a street suffix, else city
      const dashBare = /^([A-Z]{2})-(.+)$/.exec(only);
      if (dashBare && US_STATE_AND_TERRITORY_CODES.has(dashBare[1])) {
        const rest = dashBare[2].trim();
        if (/^[A-Z][a-z]/.test(rest)) {
          if (STREET_SUFFIX_RE.test(rest)) {
            return {
              location: new LocationDto({
                state: dashBare[1],
                name: asSiteName(rest),
              }),
              firm: true,
              blob: only,
            };
          }
          return {
            location: new LocationDto({
              city: rest,
              state: dashBare[1],
            }),
            firm: true,
            blob: only,
          };
        }
      }
    }
    return { location: new LocationDto({ city: only }), firm: false };
  }

  return parseCommaParts(parts, opts);
}

/**
 * Consume comma-separated parts right-to-left:
 *   tail ' - <country>' / ' - <qualifier>' handled first, then
 *   trailing country, trailing US state, 'City, Subdivision'.
 */
function parseCommaParts(
  rawParts: string[],
  opts: ResolvedParseLocationOptions,
): SingleParse | null {
  const parts = [...rawParts];

  // 'Remote, Rockville, MD' — a leading qualifier part carries flags only
  while (parts.length > 1 && isWorkplaceQualifierOnly(parts[0], true)) {
    parts.shift();
  }

  // per-part ' - ' normalization:
  //   '<country name> - X' -> records the country, keeps 'X'  (config names
  //                           only, never bare codes: 'GA - Remote' stays 'GA')
  //   'X - <qualifier>'    -> keeps 'X' (remote flags recorded separately)
  //   'X - <country>'      -> records the country, keeps 'X'  (tail country)
  //   last 'X - <other>'   -> 'X' + site name ('Chicago, IL - Atlas')
  let country: string | null = null;
  let siteName: string | null = null;
  let dashPrefixState: string | null = null;
  let dashCity: string | null = null;
  const dashConsumed: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    parts[i] = affixStrip(parts[i]); // 'Texas-Remote', 'Hybrid- Fremont'
    // 'Remote United States' — qualifier word fused inside a part
    const qf = /^(?:remote|hybrid|onsite|on-site|offsite)\s+(.+)$/i.exec(
      parts[i],
    );
    if (qf && (countryIn(qf[1], opts) || usSubdivision(qf[1]))) {
      parts[i] = qf[1].trim();
    }

    // 'MD - Gaither Rd.' / 'MA-Boston' — a US-state code prefix on the
    // FIRST part claims `state` before any country/site read (a bare
    // 'MA'/'MD' otherwise hits the alpha-2 country lookup ->
    // Morocco/Moldova). The rest is a site name when its tail is a
    // street suffix, else a provisional city. Later parts keep the
    // 'X, ST - site' reading ('Austin, TX - Atlas'). Unspaced 'ST-X'
    // requires a title-case suffix so 'CO-OP' / 'T-Mobile' survive.
    const dashPre = /^([A-Z]{2})(?:\s+-\s+|-)(.+)$/.exec(parts[i]);
    if (
      dashPre &&
      i === 0 &&
      US_STATE_AND_TERRITORY_CODES.has(dashPre[1])
    ) {
      const spaced = parts[i].includes(' - ');
      const rest = dashPre[2].trim();
      if (spaced || /^[A-Z][a-z]/.test(rest)) {
        dashConsumed.push(parts[i]);
        dashPrefixState = dashPrefixState ?? dashPre[1];
        const restCountry = countryIn(rest, opts);
        if (isWorkplaceQualifierOnly(rest, true)) {
          // 'GA - Remote' — qualifier only; flags are read from the label
        } else if (restCountry) {
          country = country ?? restCountry;
        } else if (STREET_SUFFIX_RE.test(rest)) {
          siteName = [rest, siteName].filter(Boolean).join(' - ');
        } else if (!dashCity) {
          dashCity = rest;
        } else {
          siteName = [rest, siteName].filter(Boolean).join(' - ');
        }
        parts.splice(i, 1);
        i--;
        continue;
      }
    }

    // `(?<!\s)`: the separator starts at the head of its whitespace run
    // (same matches; keeps a long run from being rescanned per position)
    const d = /^(.*?)(?<!\s)\s+-\s+(.+)$/.exec(parts[i]);
    if (!d) continue;
    // CLDR's own 'Congo - Kinshasa' is one country name, not 'X - site'
    if (opts.isoCountryNames && countryByNameOnly(parts[i], true)) continue;
    // country NAMES only (config names/aliases as countryFromString, plus
    // every ISO name with isoCountryNames), never bare codes
    const prefixCountry = countryByNameOnly(d[1], opts.isoCountryNames);
    if (prefixCountry) {
      country = country ?? prefixCountry;
      parts[i] = d[2].trim();
      i--; // reprocess the rewritten part ('US - GA - Remote' -> 'GA')
      continue;
    }
    const suffixCountry = countryIn(d[2], opts);
    if (suffixCountry) {
      country = country ?? suffixCountry;
      parts[i] = d[1].trim();
      i--;
      continue;
    }
    if (isWorkplaceQualifierOnly(d[2], true)) {
      parts[i] = d[1].trim();
      i--;
      continue;
    }
    if (i === parts.length - 1) {
      siteName = d[2].trim();
      parts[i] = d[1].trim();
      i--;
    }
  }

  // every comma part was a 'ST - X' site ('MA - Boston', 'MD - Gaither Rd.')
  if (parts.length === 0 && dashPrefixState) {
    return {
      location: new LocationDto({
        city: dashCity ?? undefined,
        state: dashPrefixState,
        country: country ?? undefined,
        name: asSiteName(siteName),
      }),
      firm: true,
      blob: dashConsumed.join(', '),
    };
  }

  // trailing country (name / alpha-2 / alpha-3).
  // (a 'ST - X' prefix sets state early, so a 2-part '…, <country>' tail
  // reaches this block instead of the 'City, Country' branch below)
  if (parts.length >= 3 || (parts.length === 2 && dashPrefixState)) {
    const tail = parts[parts.length - 1];
    let c = country ?? countryIn(tail, opts);
    // a 2-letter tail that is BOTH a US state and an ISO country ('CA','GA','IL')
    if (c && isUsStateCodeToken(tail)) {
      const others = parts.slice(0, -1);
      // US-state-first: a BARE code in a middle part ('Chennai, TN, IN') is a
      // region before a country, not the 'Pueblo, CO Penrose, CO' shape below
      const bareMiddleCode =
        opts.preferUsStateCode &&
        others.slice(1).some((p) => isMiddleRegionCode(p, opts));
      if (
        !bareMiddleCode &&
        others.some(
          (p) =>
            /\b[A-Z]{2}\b/.test(p) &&
            Boolean(normalizeUsState(p.split(' ')[0])),
        )
      ) {
        // the middle part itself carries a US-state code
        // ('Pueblo, CO Penrose, CO') -> the tail is the US state
        c = null;
      } else if (
        !country &&
        opts.preferUsStateCode &&
        usStateTailWins(tail, others, opts)
      ) {
        // 'Downtown, Los Angeles, CA' / 'Springfield, Sangamon County, IL'
        // -> the US state, not Canada / Israel. A literal US part
        // ('United States, San Diego, CA') is the country, not the city.
        c = null;
        const usIdx = others.findIndex(
          (p) => countryIn(p, opts) === US_COUNTRY_DISPLAY,
        );
        if (usIdx >= 0) {
          country = US_COUNTRY_DISPLAY;
          parts.splice(usIdx, 1);
        }
      }
      // otherwise (option off, or 'Toronto, Ontario, CA') the ISO country
      // wins — the fork's reading
    }
    if (!country && c) {
      country = c;
      parts.pop();
    }
  }

  // 'Tbilisi, Georgia' / 'Batumi, Adjara, Georgia' — a trailing 'Georgia'
  // next to a Georgian place is the country; everywhere else it stays the
  // US state ('Atlanta, Georgia') (Spec 1699)
  if (
    opts.isoCountryNames &&
    !country &&
    !dashPrefixState &&
    parts.length >= 2 &&
    parts[parts.length - 1].toLowerCase() === 'georgia' &&
    parts.slice(0, -1).some(isGeorgianPlace)
  ) {
    country = isoDisplay('GE');
    parts.pop();
  }

  // merged-blob label: consumed 'ST - X' parts lead, then the remaining
  // parts minus the country segment ('Clarksburg, MD, United States' ->
  // 'Clarksburg, MD')
  const blob = [...dashConsumed, ...dedupeConsecutive(parts)].join(', ');

  // trailing US subdivision (state code/name or territory name)
  let state: string | null = dashPrefixState;
  /** `state` came from the trailing part ('Lebanon, PA'), not a 'ST - X' prefix */
  let stateFromTail = false;
  {
    const tail = parts[parts.length - 1];
    const st = tail ? usSubdivision(tail) : null;
    if (st && parts.length >= 2) {
      state = st;
      stateFromTail = true;
      parts.pop();
    }
  }

  // 'City, Subdivision' — verbatim subdivision when not US/country
  if (parts.length === 2 && !state) {
    const [city, sub] = parts;
    const subCountry = countryIn(sub, opts);
    // once a tail country is read, a short code before it is that country's
    // region, not a second country: 'Munich, BY, DE' is Bavaria (not
    // Belarus), 'Chennai, TN, IN' Tamil Nadu (not Tunisia)
    const c =
      subCountry &&
      country &&
      subCountry !== country &&
      SHORT_REGION_CODE_RE.test(sub.trim())
        ? null
        : subCountry;
    if (c) {
      // 'NY, USA' / 'Arizona, USA' / 'Puerto Rico, USA' — a US subdivision
      // in the city slot is a state, not a city. Collision names stay
      // cities ('New York, USA').
      if (!BARE_STATE_NAME_COLLISIONS.has(city.toLowerCase())) {
        const cityState = usSubdivision(city);
        if (cityState) {
          return {
            location: new LocationDto({
              state: cityState,
              country: c,
              name: asSiteName(siteName),
            }),
            firm: true,
            blob: city,
          };
        }
        const split = bareLabelWithStateSuffix(city);
        if (split) {
          return {
            location: new LocationDto({
              city: split.city,
              state: split.state,
              country: c,
              name: asSiteName(siteName),
            }),
            firm: true,
            blob: city,
          };
        }
      }
      return {
        location: new LocationDto({
          city,
          country: c,
          name: asSiteName(siteName),
        }),
        firm: true,
        blob: city,
      };
    }
    // 'City, Remote' / 'City, Hybrid' — qualifier tail stays out of fields
    if (isWorkplaceQualifierOnly(sub, true)) {
      return {
        location: new LocationDto({
          city,
          country: country ?? undefined,
        }),
        firm: Boolean(country),
        blob,
      };
    }
    // 'City, CO Taylor' — US-state code prefix + site descriptor
    const codeTail = /^([A-Z]{2})\s+(.+)$/.exec(sub);
    if (codeTail && US_STATE_AND_TERRITORY_CODES.has(codeTail[1])) {
      return {
        location: new LocationDto({
          city,
          state: codeTail[1],
          name: asSiteName(
            [codeTail[2], siteName].filter(Boolean).join(' - '),
          ),
          country: country ?? undefined,
        }),
        firm: true,
        blob,
      };
    }
    // site-descriptor tails are names, not subdivisions
    if (!QUALIFIER_WORD_RE.test(sub) && SITE_DESCRIPTOR_RE.test(sub)) {
      return {
        location: new LocationDto({
          city,
          name: asSiteName(
            [sub, siteName].filter(Boolean).join(' - '),
          ),
          country: country ?? undefined,
        }),
        firm: false,
        blob,
      };
    }
    return {
      location: new LocationDto({
        city,
        state: sub,
        country: country ?? undefined,
        name: asSiteName(siteName),
      }),
      firm: true,
      blob,
    };
  }

  // single remaining part (e.g. after a ' - <qualifier>' strip): bare country
  // or US state still resolves; a lone qualifier carries flags only
  if (parts.length === 1) {
    const only = parts[0];
    if (isWorkplaceQualifierOnly(only, true)) {
      if (!country) return null;
      return { location: new LocationDto({ country }), firm: true };
    }
    // 'Remote, CA' — opt-in (`preferUsStateAfterQualifier`): a lone
    // ambiguous code left after a qualifier reads as the US state first,
    // like a bare 'CA' label (the bare-state option decides state vs city).
    // Off by default: 'Remote, DE' / 'Hybrid, CA' keep the fork's country.
    if (
      opts.preferUsStateCode &&
      opts.preferUsStateAfterQualifier &&
      !state &&
      isUsStateCodeToken(only)
    ) {
      const bare = opts.allowBareStateProvince;
      return {
        location: new LocationDto({
          city: bare ? undefined : only,
          state: bare ? only.trim().toUpperCase() : undefined,
          country: country ?? undefined,
          name: asSiteName(siteName),
        }),
        firm: bare || Boolean(country),
        blob,
      };
    }
    const c = countryIn(only, opts);
    // 'Lebanon, PA' / 'Jamaica, NY' / 'Peru, IN': after a US-state tail the
    // leftover part is a US town named after a country, not the country —
    // unless the tail code IS that country's code ('India, IN') (Spec 1699)
    const usTownNamedLikeCountry =
      opts.isoCountryNames &&
      c !== null &&
      c !== US_COUNTRY_DISPLAY &&
      stateFromTail &&
      !country &&
      state !== null &&
      countryIn(state, opts) !== c;
    if (c && !usTownNamedLikeCountry) {
      return {
        location: new LocationDto({
          country: country ?? c,
          state: state ?? undefined,
          name: asSiteName(siteName),
        }),
        firm: true,
        blob,
      };
    }
    const st =
      !state &&
      opts.allowBareStateProvince &&
      !BARE_STATE_NAME_COLLISIONS.has(only.toLowerCase())
        ? usSubdivision(only)
        : null;
    if (st) {
      return {
        location: new LocationDto({
          state: st,
          country: country ?? undefined,
          name: asSiteName(siteName),
        }),
        firm: true,
        blob,
      };
    }
    const split =
      !state && opts.allowBareStateProvince
        ? bareLabelWithStateSuffix(only)
        : null;
    if (split) {
      return {
        location: new LocationDto({
          city: split.city,
          state: split.state,
          country: country ?? undefined,
          name: asSiteName(siteName),
        }),
        firm: true,
        blob,
      };
    }
    // a 'ST - X' prefix was consumed — the leftover part is the site city
    // ('Rockville'), a 'City <descriptor>' tail ('Rockville Corp Hqtrs'),
    // or a pure site name when the dash suffix already claimed the city
    if (dashPrefixState) {
      if (dashCity) {
        return {
          location: new LocationDto({
            city: dashCity,
            state,
            country: country ?? undefined,
            name: asSiteName([siteName, only].filter(Boolean).join(' - ')),
          }),
          firm: true,
          blob,
        };
      }
      const desc = splitCityDescriptor(only);
      if (desc) {
        return {
          location: new LocationDto({
            city: desc.city,
            state,
            country: country ?? undefined,
            name: asSiteName(
              [siteName, desc.name].filter(Boolean).join(' - '),
            ),
          }),
          firm: true,
          blob,
        };
      }
      if (isSiteDescriptorOnly(only)) {
        return {
          location: new LocationDto({
            state,
            country: country ?? undefined,
            name: asSiteName([siteName, only].filter(Boolean).join(' - ')),
          }),
          firm: true,
          blob,
        };
      }
      return {
        location: new LocationDto({
          city: only,
          state,
          country: country ?? undefined,
          name: asSiteName(siteName),
        }),
        firm: true,
        blob,
      };
    }
    return {
      location: new LocationDto({
        city: only,
        state: state ?? undefined,
        country: country ?? undefined,
        name: asSiteName(siteName),
      }),
      firm: Boolean(state || country),
      blob,
    };
  }

  const city = dedupeConsecutive(parts).join(', ');
  if (!city) return null;
  const location = new LocationDto({
    city,
    state: state ?? undefined,
    country: country ?? undefined,
    name: asSiteName(siteName),
  });
  return { location, firm: Boolean(state || country) };
}

/** 'South El Monte, South El Monte, CA, US' -> collapse repeated tokens. */
function dedupeConsecutive(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].toLowerCase() === p.toLowerCase())
      continue;
    out.push(p);
  }
  return out;
}

/** Title-case bare-city candidate ('San Francisco', 'Bellevue', 'NYC'). */
function isBareCityCandidate(value: string): boolean {
  return /^[A-Z][A-Za-z.' -]*$/.test(value.trim());
}

/** Per-call memoized `parseSingleLabel` (one options set per list parse). */
type LabelParser = (label: string) => SingleParse | null;

/**
 * Split a label on word connectors ' & ' ' and ' ' or ' ' / ' (all require
 * spaces). Validation: every part must be a qualifier or a firm parse —
 * EXCEPT ' & ' / ' / ' which also allow a title-case bare city when some
 * other part is firm. ' and ' / ' or ' are stricter so entity names like
 * 'BMS Test and Trials' and 'Austin or Bryan' stay intact.
 */
function tryWordSplit(
  cleaned: string,
  parse: LabelParser,
  opts: ResolvedParseLocationOptions,
): string[] | null {
  // 'or'/'and' never split on an ALL-CAPS 2-letter token — 'Portland, OR / X'
  // must keep Oregon, not treat 'OR' as a connector
  const parts: string[] = [];
  const conns: string[] = [];
  // `(?<!\s)`: a connector match starts at the head of its whitespace run
  const connRe = /(?<!\s)\s+(&|\/|and|or)\s+/gi;
  let insideCountryName: ((index: number) => boolean) | null = null;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = connRe.exec(cleaned))) {
    if (/^[A-Z]{2}$/.test(m[1])) continue; // 'OR' = Oregon, not a connector
    // 'Sarajevo, Bosnia & Herzegovina' — the connector belongs to a country
    // name that fills its comma part (Spec 1699)
    if (opts.isoCountryNames) {
      insideCountryName ??= countryNamePartChecker(cleaned);
      if (insideCountryName(m.index)) continue;
    }
    parts.push(cleaned.slice(last, m.index).trim());
    conns.push(m[1].toLowerCase());
    last = m.index + m[0].length;
  }
  parts.push(cleaned.slice(last).trim());
  if (parts.length < 2) return null;

  let firm = false;
  let failed = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const prevConn = i > 0 ? conns[i - 1] : null;
    if (isWorkplaceQualifierOnly(part, true)) {
      firm = true;
      continue;
    }
    const parsed = parse(part);
    if (parsed?.firm) {
      firm = true;
      continue;
    }
    const adjConn = prevConn ?? conns[i] ?? null;
    const softOk =
      parsed &&
      isBareCityCandidate(part) &&
      (adjConn === '&' || adjConn === '/');
    if (!softOk) {
      failed = true;
      break;
    }
  }
  return !failed && firm ? parts : null;
}

/**
 * For `tryWordSplit`: does the comma part of `text` holding `index` name a
 * country as a whole ('Bosnia & Herzegovina', 'Trinidad and Tobago')? Queries
 * must come in ascending `index` order. Linear overall: the comma scan only
 * moves forward, each part is looked up once, and a part too long to be a
 * country name is never sliced.
 */
function countryNamePartChecker(text: string): (index: number) => boolean {
  let partStart = 0;
  let partEnd = text.indexOf(',');
  if (partEnd < 0) partEnd = text.length;
  let known: boolean | null = null;
  return (index) => {
    while (index > partEnd) {
      partStart = partEnd + 1;
      const next = text.indexOf(',', partStart);
      partEnd = next < 0 ? text.length : next;
      known = null;
    }
    if (known === null) {
      known =
        partEnd - partStart <= MAX_COUNTRY_NAME_LENGTH &&
        countryByNameOnly(text.slice(partStart, partEnd), true) !== null;
    }
    return known;
  };
}

/**
 * Comma-packed multi-site: 'Fremont, CA, Salem, OR, Pittsburgh, PA' (pairs) or
 * 'Bellevue, Washington, United States, Everett, Washington, United States'
 * (triples). Accepted only when every group parses firm.
 */
function tryCommaGroupSplit(
  cleaned: string,
  parse: LabelParser,
): string[] | null {
  const parts = cleaned
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 4) return null;

  const width = parts.length % 3 === 0 ? 3 : parts.length % 2 === 0 ? 2 : 0;
  if (!width) return null;
  const groups: string[] = [];
  for (let i = 0; i < parts.length; i += width) {
    groups.push(parts.slice(i, i + width).join(', '));
  }
  const allFirm = groups.every((g) => {
    if (isWorkplaceQualifierOnly(g, true)) return true;
    const parsed = parse(g);
    if (!parsed?.firm) return false;
    // pair groups additionally need a *recognized* subdivision — a verbatim
    // 'City, Subdivision' is too weak ('BMS Test and Trials, Pascagoula')
    if (width === 2) {
      return Boolean(
        (parsed.location.state &&
          (US_STATE_AND_TERRITORY_CODES.has(parsed.location.state) ||
            US_TERRITORY_DISPLAY_NAMES.has(parsed.location.state))) ||
          parsed.location.country,
      );
    }
    return true;
  });
  return allFirm ? groups : null;
}

/**
 * Normalize an ordered list of location labels into the merged singular DTO
 * plus per-site structured entries.
 *
 * `country` fields are literal: only country tokens actually present in labels
 * produce them. A US-state code implies 'United States' internally — that
 * implication can veto a conflicting literal stamp, but never creates one.
 */
export function parseLocationList(
  rawLocations: Array<string | null | undefined>,
  options?: ParseLocationOptions,
): ParsedLocationList {
  const opts = resolveOptions(options);
  const concrete: Array<{
    location: LocationDto;
    label: string;
    key: string;
    blob?: string;
    /** over-cap label kept verbatim, heuristics skipped */
    verbatim?: boolean;
  }> = [];
  const seen = new Set<string>();
  /** city|state key -> index in `concrete` (was a findIndex per entry: O(k²)) */
  const csIndex = new Map<string, number>();
  let remoteMentioned = false;
  let workFromHomeType: WorkFromHomeType | null = null;

  // parts are re-parsed by the split validators and again by emit(); one
  // parse per distinct string per call
  const memo = new Map<string, SingleParse | null>();
  const parse: LabelParser = (label) => {
    let parsed = memo.get(label);
    if (parsed === undefined) {
      parsed = parseSingleLabel(label, opts);
      memo.set(label, parsed);
    }
    return parsed;
  };

  const addEntry = (normalized: string, location: LocationDto, blob?: string) => {
    const label = [location.city, location.state, location.country]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .join(', ');
    if (!label) return;
    // collapse on city|state: a later country-bearing variant replaces a
    // country-less duplicate ('Jersey City, NJ' vs 'Jersey City, NJ, US')
    const csKey = [location.city, location.state]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .join('|')
      .toLowerCase();
    const existingIdx = csIndex.get(csKey);
    if (existingIdx !== undefined) {
      const existing = concrete[existingIdx];
      if (!existing.location.country && location.country) {
        const dto = new LocationDto({ ...location });
        if (normalized !== label) dto.text = normalized;
        concrete[existingIdx] = {
          location: dto,
          label,
          key: label.toLowerCase(),
          blob,
        };
      }
      return;
    }
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const dto = new LocationDto({ ...location });
    if (normalized !== label) dto.text = normalized;
    csIndex.set(csKey, concrete.length);
    concrete.push({ location: dto, label, key, blob });
  };

  /** over-cap label: one verbatim entry, no heuristics run on it */
  const addVerbatim = (normalized: string) => {
    const key = `\u0000verbatim|${normalized.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    concrete.push({
      location: new LocationDto({
        name: asSiteName(normalized),
        text: normalized,
      }),
      label: normalized,
      key,
      blob: normalized,
      verbatim: true,
    });
  };

  const emit = (segment: string) => {
    if (isWorkplaceQualifierOnly(segment, true)) return;
    // word separators first ('Denver, CO & San Francisco, CA' etc.)
    const wordParts = tryWordSplit(segment, parse, opts) ?? [segment];
    for (const wp of wordParts) {
      if (isWorkplaceQualifierOnly(wp, true)) continue;
      // then comma-packed groups
      const groups = tryCommaGroupSplit(wp, parse) ?? [wp];
      for (const g of groups) {
        if (isWorkplaceQualifierOnly(g, true)) continue;
        const parsed = parse(g);
        if (!parsed) continue;
        addEntry(g, parsed.location, parsed.blob);
      }
    }
  };

  for (const raw of rawLocations) {
    const normalized = raw?.replace(/\s+/g, ' ').trim() ?? '';
    if (!normalized) continue;

    const flags = remoteFlags(normalized);
    remoteMentioned = remoteMentioned || flags.remoteMentioned;
    workFromHomeType = mergeWorkFromHomeType(
      workFromHomeType,
      flags.workFromHomeType,
    );

    if (isWorkplaceQualifierOnly(normalized, true)) continue;

    // ';' and '|' are unambiguous list separators — split first, then extract.
    // The length cap applies per chunk (one site), so a long multi-site list
    // keeps every structured site; only an over-cap chunk goes verbatim.
    for (const chunk of normalized.split(/\s*[;|]+\s*/)) {
      const trimmed = chunk.trim();
      if (!trimmed) continue;
      if (opts.maxLabelLength > 0 && trimmed.length > opts.maxLabelLength) {
        addVerbatim(trimmed);
        continue;
      }
      const cleaned = extractGeo(trimmed);
      if (cleaned) emit(cleaned);
    }
  }

  // bare 'Los Angeles' collapses into a 'Los Angeles, CA' entry — the set of
  // cities that carry a state is computed once (was rebuilt per entry)
  const citiesWithState = new Set<string>();
  for (const { location } of concrete) {
    const city = location.city?.trim().toLowerCase();
    if (city && location.state) citiesWithState.add(city);
  }
  const filteredConcrete = concrete.filter(
    (item) => !isBareCityDuplicate(item, citiesWithState),
  );
  const locations = filteredConcrete.map(({ location }) => location);
  const labels = filteredConcrete.map(({ label }) => label);

  /** implied country per entry: explicit country, or US-state code -> US. */
  const impliedCountry = (loc: LocationDto): string | null => {
    if (loc.country) return loc.country;
    if (
      loc.state &&
      (US_STATE_AND_TERRITORY_CODES.has(loc.state) ||
        US_TERRITORY_DISPLAY_NAMES.has(loc.state))
    )
      return 'United States';
    return null;
  };
  /**
   * merged country = the sole LITERAL country seen across labels — inference
   * (TX -> US) can veto, never stamp:
   *  - vetoed by an entry implying a different country
   *  - vetoed by an entry with an unrecognized subdivision (can't confirm)
   * bare-city entries (no state/country) are neutral.
   */
  const implied = locations.map(impliedCountry);
  const literalCountries = new Set(
    locations.map((l) => l.country).filter((c): c is string => Boolean(c)),
  );
  const sole = literalCountries.size === 1 ? [...literalCountries][0] : null;
  const veto =
    sole !== null &&
    locations.some(
      (l, i) =>
        (implied[i] !== null && implied[i] !== sole) ||
        (implied[i] === null && Boolean(l.state)),
    );
  const commonCountry = sole !== null && !veto ? sole : null;
  /** merged city blob excludes country-only entries */
  const siteLabels = filteredConcrete
    .filter(({ location: l, verbatim }) => l.city || l.state || verbatim)
    .map((item) => item.blob ?? item.label);

  // legacy opt-in: remote-only input (no concrete site) -> { city: 'Remote' }
  if (opts.emitRemoteCity && remoteMentioned && siteLabels.length === 0) {
    return {
      location: new LocationDto({
        city: 'Remote',
        country: commonCountry ?? undefined,
      }),
      locations,
      labels,
      remoteMentioned,
      workFromHomeType,
    };
  }

  if (locations.length === 0) {
    return {
      location: commonCountry ? new LocationDto({ country: commonCountry }) : null,
      locations,
      labels,
      remoteMentioned,
      workFromHomeType,
    };
  }

  if (locations.length === 1) {
    const location = new LocationDto({
      ...locations[0],
      country: locations[0].country ?? commonCountry ?? undefined,
    });
    return {
      location,
      locations: [location],
      labels,
      remoteMentioned,
      workFromHomeType,
    };
  }

  const merged =
    siteLabels.length || commonCountry
      ? new LocationDto({
          city: siteLabels.join('; ') || undefined,
          country: commonCountry ?? undefined,
        })
      : null;
  return { location: merged, locations, labels, remoteMentioned, workFromHomeType };
}

/** One character of an address head run: `[A-Za-z\s]`. */
const ADDRESS_HEAD_CHAR_RE = /[A-Za-z\s]/;
const ADDRESS_LETTER_RE = /[A-Za-z]/;
/** Sticky tails, tried at each comma: ', ST 12345' / ', ST[ 12345]'. */
const US_ADDRESS_TAIL_ZIP_RE = /,\s+[A-Z]{2}\s+\d{5}/y;
const US_ADDRESS_TAIL_OPTIONAL_ZIP_RE = /,\s+[A-Z]{2}(?:\s+\d{5})?/y;

/**
 * The first US 'City, ST ZIP' / 'City, ST' snippet in free text (a meta
 * description, a whole detail page), found in linear time (Spec 1689). It is
 * the same leftmost match as the regexes plugins ran with `.exec` over
 * third-party HTML:
 *  - zip 'required': `/[A-Za-z\s]+,\s+[A-Z]{2}\s+\d{5}/`
 *  - zip 'optional': `/[A-Za-z][A-Za-z\s]+,\s+[A-Z]{2}(?:\s+\d{5})?/`
 * Unanchored, those rescanned a long letters-and-spaces stretch from every
 * start position — quadratic, 21.8 s on 110 KB of unpunctuated prose. A comma
 * ends a head run, so each run's only candidate is the comma right after it:
 * this walks the commas left to right, tries the tail there, and extends the
 * head leftwards once for the first comma whose tail matches.
 */
export function findUsAddressSnippet(
  text: string,
  zip: 'required' | 'optional',
): string | null {
  const tail = zip === 'required' ? US_ADDRESS_TAIL_ZIP_RE : US_ADDRESS_TAIL_OPTIONAL_ZIP_RE;
  for (let comma = text.indexOf(','); comma >= 0; comma = text.indexOf(',', comma + 1)) {
    tail.lastIndex = comma;
    if (!tail.test(text)) continue;
    let start = comma;
    while (start > 0 && ADDRESS_HEAD_CHAR_RE.test(text[start - 1])) start--;
    if (zip === 'optional') {
      // the head opens on a letter and has at least one more character
      while (start < comma && !ADDRESS_LETTER_RE.test(text[start])) start++;
      if (comma - start < 2) continue;
    } else if (start === comma) {
      continue;
    }
    return text.slice(start, tail.lastIndex);
  }
  return null;
}

/**
 * Parse a single location label (or a small multi-site string) into the merged
 * geographic view plus workplace flags. Shares the list pipeline so separators
 * and qualifiers behave identically.
 */
export function parseLocationText(
  raw: string | null | undefined,
  options?: ParseLocationOptions,
): ParsedLocationText {
  const normalized = raw?.replace(/\s+/g, ' ').trim() ?? '';
  if (!normalized) {
    return { location: null, remoteMentioned: false, workFromHomeType: null };
  }
  const flags = remoteFlags(normalized);
  const { location } = parseLocationList([normalized], options);
  return { location, ...flags };
}

function mergeWorkFromHomeType(
  current: WorkFromHomeType | null,
  next: WorkFromHomeType | null,
): WorkFromHomeType | null {
  if (!current) return next;
  if (!next || next === current) return current;
  return 'Hybrid or Remote';
}

/**
 * A bare city ('Los Angeles') that another entry already carries WITH a state.
 * `citiesWithState` holds the lower-cased cities of every state-bearing
 * entry; the item itself has no state, so it can never match itself.
 */
function isBareCityDuplicate(
  item: { location: LocationDto; label: string },
  citiesWithState: ReadonlySet<string>,
): boolean {
  const city = item.location.city?.trim().toLowerCase();
  if (
    !city ||
    item.location.state ||
    item.location.country ||
    item.label.includes(',')
  ) {
    return false;
  }
  return citiesWithState.has(city);
}
