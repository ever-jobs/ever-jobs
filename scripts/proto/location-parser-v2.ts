/**
 * PROTOTYPE — not wired into production. Mirrors parseLocationList/parseLocationText
 * with the proposed rules so corpus diffs can be generated before any real change:
 *
 *  - country recognition: COUNTRY_CONFIG aliases + ISO alpha-2 + alpha-3 map
 *  - bare country segments emit {country} entries (never {city})
 *  - 'City, Subdivision' / 'City, Subdivision, Country' -> state verbatim
 *  - trailing ' - <country>' suffix recognized; ' - <qualifier>' stripped
 *  - '(N)' serial markers stripped
 *  - separators: ';' '|' always; ' & ' ' and ' ' or ' ' / ' via try-split-validate
 *  - comma-packed multi-site lists: triple (City,ST,Country) or pair (City,ST) groups
 *  - 'Hybrid|Remote (geo...)' -> paren content is the geo, outside qualifier-only
 *  - 'Remote in <country>' -> {country} + remote flag
 *  - text stamped only when the label is not trivially regenerable
 *  - merged location never carries a stamped country and never gets city:'Remote'
 *  - precedence: subdivision slot checks US-state before country; a bare whole-label
 *    2-letter code checks US-state before ISO alpha-2 ('GA' -> Georgia not Gabon)
 */
import { LocationDto } from '@ever-jobs/models';
import {
  COUNTRY_CONFIG,
  Country,
  countryFromString,
  getIndeedDomain,
} from '@ever-jobs/models';
import { regionNameFromCode } from '../../packages/common/src/utils/country-name';
import { matchRemoteInGeo } from '../../packages/common/src/utils/location-parser';

type WorkFromHomeType = 'Hybrid' | 'Remote' | 'Hybrid or Remote';

export interface ParsedLocationTextV2 {
  location: LocationDto | null;
  remoteMentioned: boolean;
  workFromHomeType: WorkFromHomeType | null;
}

export interface ParsedLocationListV2 {
  location: LocationDto | null;
  locations: LocationDto[];
  labels: string[];
  remoteMentioned: boolean;
  workFromHomeType: WorkFromHomeType | null;
}

export interface ParseLocationOptionsV2 {
  allowBareStateProvince?: boolean;
}

const US_STATE_AND_TERRITORY_CODES = new Set([
  'AA','AE','AK','AL','AP','AR','AS','AZ','CA','CO','CT','DC','DE','FL','FM','GA','GU','HI','IA','ID',
  'IL','IN','KS','KY','LA','MA','MD','ME','MH','MI','MN','MO','MP','MS','MT','NC','ND','NE','NH','NJ',
  'NM','NV','NY','OH','OK','OR','PA','PR','PW','RI','SC','SD','TN','TX','UT','VA','VI','VT','WA','WI',
  'WV','WY',
]);

const US_STATE_NAME_TO_CODE: Record<string, string> = {
  alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',
  delaware:'DE',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',
  kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',
  minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
  'north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI',
  'south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',
  virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY',
  'district of columbia':'DC',
};

const COUNTRY_ALPHA3: Record<string, string> = {
  ARE:'United Arab Emirates',ARG:'Argentina',AUS:'Australia',AUT:'Austria',BEL:'Belgium',
  BGR:'Bulgaria',BHR:'Bahrain',BRA:'Brazil',CAN:'Canada',CHE:'Switzerland',CHL:'Chile',
  CHN:'China',COL:'Colombia',CRI:'Costa Rica',CYP:'Cyprus',CZE:'Czech Republic',DEU:'Germany',
  DNK:'Denmark',ECU:'Ecuador',EGY:'Egypt',ESP:'Spain',EST:'Estonia',FIN:'Finland',FRA:'France',
  GBR:'United Kingdom',GRC:'Greece',HKG:'Hong Kong',HUN:'Hungary',IDN:'Indonesia',IND:'India',
  IRL:'Ireland',ISR:'Israel',ITA:'Italy',JPN:'Japan',KOR:'South Korea',KWT:'Kuwait',LTU:'Lithuania',
  LVA:'Latvia',LUX:'Luxembourg',MAR:'Morocco',MEX:'Mexico',MLT:'Malta',MYS:'Malaysia',
  NGA:'Nigeria',NLD:'Netherlands',NOR:'Norway',NZL:'New Zealand',OMN:'Oman',PAK:'Pakistan',
  PAN:'Panama',PER:'Peru',PHL:'Philippines',POL:'Poland',PRT:'Portugal',QAT:'Qatar',ROU:'Romania',
  SAU:'Saudi Arabia',SGP:'Singapore',SVK:'Slovakia',SVN:'Slovenia',SWE:'Sweden',THA:'Thailand',
  TUR:'Turkey',TWN:'Taiwan',UAE:'United Arab Emirates',UKR:'Ukraine',URY:'Uruguay',
  USA:'United States',VEN:'Venezuela',VNM:'Vietnam',ZAF:'South Africa',
};

/**
 * State names that collide with prominent city names — a bare label is too
 * ambiguous to resolve to a state ('Washington' DC?, 'New York' the city?,
 * 'Georgia' the country?). Codes stay unambiguous and always resolve.
 */
const BARE_STATE_NAME_COLLISIONS = new Set(['washington', 'new york', 'georgia']);

/** qualifier-flavored text is never a site name ('Hybrid possible', 'On-site') */
const QUALIFIER_WORD_RE = /\b(?:hybrid|remote|on-?site|offsite|telecommut\w*|work\s+from\s+home|wfh)\b/i;
const asSiteName = (v: string | null | undefined): string | undefined =>
  v && !QUALIFIER_WORD_RE.test(v) ? v : undefined;

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

/** Recognize a country token in COUNTRY-slot context (full names + aliases + codes). */
export function normalizeCountryOnlyV2(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\./g, '');
  if (!normalized) return null;
  // pragmatic alias: 'Korea' on job boards means South Korea (KOR)
  if (normalized === 'korea') return 'South Korea';
  try {
    const country = countryFromString(normalized);
    const display = countryDisplay(country);
    if (display) return display;
  } catch {
    /* not a configured alias */
  }
  if (/^[a-z]{2}$/.test(normalized)) {
    const name = regionNameFromCode(normalized.toUpperCase());
    if (name) return name;
  }
  if (/^[a-z]{3}$/.test(normalized)) {
    const name = COUNTRY_ALPHA3[normalized.toUpperCase()];
    if (name) return name;
  }
  return null;
}

export function normalizeUsStateV2(value: string): string | null {
  const code = value.trim().toUpperCase();
  if (US_STATE_AND_TERRITORY_CODES.has(code)) return code;
  return US_STATE_NAME_TO_CODE[value.trim().toLowerCase()] ?? null;
}

function isWorkplaceQualifierOnlyV2(value: string, allowSlash: boolean): boolean {
  if (!/\b(?:hybrid|remote)\b/i.test(value)) return false;
  const withoutWords = value
    .replace(/\b(?:hybrid|remote)\b/gi, '')
    // 'and'/'or' as filler words — but never an ALL-CAPS 2-letter state code
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
      ? remoteMentioned ? 'Hybrid or Remote' : 'Hybrid'
      : remoteMentioned ? 'Remote' : null,
  };
}

/**
 * Reduce a raw label to its geographic core:
 *  - '(N)' serial markers removed
 *  - 'Hybrid (Clarksburg, MD, US)' / 'Remote (Paris, FR)' — when the text
 *    outside parens is workplace words, the paren content is the geo part
 *  - qualifier parens like '(Remote)' removed
 */
const QUALIFIER_PREFIX_RE =
  /^(?:hybrid|remote|onsite|on-site|offsite|any office)\b\s*[-–—]\s*/i;
// `(?<!\s)`: match only from the head of a whitespace run (linear; same
// matches) — mirrors the production parser's Spec 1689 hardening
const QUALIFIER_SUFFIX_RE =
  /(?<!\s)\s*[-–—]\s*(?:remote|hybrid|onsite|on-site|offsite)\b\s*$/i;

function affixStrip(s: string): string {
  return s.replace(QUALIFIER_PREFIX_RE, '').replace(QUALIFIER_SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
}

function extractGeo(normalized: string): string {
  const noSerial = normalized.replace(/\(\d+\)/g, ' ');
  const parens = [...noSerial.matchAll(/\(([^()]*)\)/g)];
  if (parens.length === 0) return affixStrip(noSerial);

  const outside = noSerial.replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const outsideQualifierish = isWorkplaceQualifierOnlyV2(outside, true) ||
    /^(?:hybrid|remote|any|office|on-?site|offsite|onsite)[\s\-–—:]*$/i.test(outside) ||
    /^(?:hybrid|remote)[\s\-–—]+(?:any\s+)?office[\s\-–—:]*$/i.test(outside);

  const contents = parens.map((m) => m[1].trim()).filter(Boolean);
  const geoContents = contents.filter((c) => !isWorkplaceQualifierOnlyV2(c, true));
  if (outsideQualifierish && geoContents.length) {
    return geoContents.join(', ');
  }
  // keep non-qualifier parens inline (they may carry part of the name)
  const kept = noSerial.replace(/\(([^()]*)\)/g, (whole, content: string) =>
    isWorkplaceQualifierOnlyV2(content, true) ? ' ' : content,
  );
  // unspaced qualifier affixes: 'Hybrid- Fremont, CA', 'Texas-Remote', 'Onsite- Salem, OR'
  return affixStrip(kept);
}

interface SingleParse {
  location: LocationDto;
  firm: boolean; // carries state or country (structural evidence)
  /** label for the merged-city blob: input minus any literal country segment */
  blob?: string;
}

/** Parse ONE clean label into a geographic entry. Right-to-left consumption. */
function parseSingleLabel(
  cleaned: string,
  options?: ParseLocationOptionsV2,
): SingleParse | null {
  if (!cleaned) return null;

  // 'Remote in <country>' / 'Remote - <country>'
  // linear matcher shared with the production parser: the former
  // `/^(?:remote|hybrid)\b(?:[\s-]*\w+)*?\s+in\s+(.+)$/i` was exponential on
  // 'Remote …' labels without ' in ' (Spec 1689)
  const remoteIn = matchRemoteInGeo(cleaned);
  if (remoteIn !== null) {
    const c = normalizeCountryOnlyV2(remoteIn);
    if (c) return { location: new LocationDto({ country: c }), firm: true };
  }
  const remoteDash = /^(?:remote|hybrid)\s*[-–—]\s*(.+)$/i.exec(cleaned);
  if (remoteDash) {
    const c = normalizeCountryOnlyV2(remoteDash[1]);
    if (c) return { location: new LocationDto({ country: c }), firm: true };
  }

  // whole-label country (bare 'GA' resolves as US state first — see below)
  const wholeCountry = normalizeCountryOnlyV2(cleaned);
  if (wholeCountry) {
    // 2-letter code that is also a US state -> prefer US state reading
    if (/^[A-Za-z]{2}$/.test(cleaned.trim()) && normalizeUsStateV2(cleaned)) {
      return { location: new LocationDto({ state: normalizeUsStateV2(cleaned)! }), firm: true };
    }
    return { location: new LocationDto({ country: wholeCountry }), firm: true };
  }

  const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  if (parts.length === 1 && !cleaned.includes(' - ')) {
    const only = parts[0];
    if (
      options?.allowBareStateProvince !== false &&
      !BARE_STATE_NAME_COLLISIONS.has(only.toLowerCase())
    ) {
      const bareState = normalizeUsStateV2(only);
      if (bareState) return { location: new LocationDto({ state: bareState }), firm: true };
    }
    return { location: new LocationDto({ city: only }), firm: false };
  }

  return parseCommaParts(parts, options);
}

/**
 * Consume comma-separated parts right-to-left:
 *   tail ' - <country>' / ' - <qualifier>' handled first, then
 *   trailing country, trailing US state, 'City, Subdivision'.
 */
function parseCommaParts(
  rawParts: string[],
  options?: ParseLocationOptionsV2,
): SingleParse | null {
  const parts = [...rawParts];

  // 'Remote, Rockville, MD' — a leading qualifier part carries flags only
  while (parts.length > 1 && isWorkplaceQualifierOnlyV2(parts[0], true)) {
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
  for (let i = 0; i < parts.length; i++) {
    parts[i] = affixStrip(parts[i]); // 'Texas-Remote', 'Hybrid- Fremont'
    // 'Remote United States' — qualifier word fused inside a part
    const qf = /^(?:remote|hybrid|onsite|on-site|offsite)\s+(.+)$/i.exec(parts[i]);
    if (qf && (normalizeCountryOnlyV2(qf[1]) || normalizeUsStateV2(qf[1]))) {
      parts[i] = qf[1].trim();
    }
    const d = /^(.*?)(?<!\s)\s+-\s+(.+)$/.exec(parts[i]);
    if (!d) continue;
    let prefixCountry: string | null = null;
    try {
      prefixCountry = countryDisplay(countryFromString(d[1].trim().toLowerCase()));
    } catch {
      /* not a country-name prefix */
    }
    if (prefixCountry) {
      country = country ?? prefixCountry;
      parts[i] = d[2].trim();
      i--; // reprocess the rewritten part ('US - GA - Remote' -> 'GA')
      continue;
    }
    const suffixCountry = normalizeCountryOnlyV2(d[2]);
    if (suffixCountry) {
      country = country ?? suffixCountry;
      parts[i] = d[1].trim();
      i--;
      continue;
    }
    if (isWorkplaceQualifierOnlyV2(d[2], true)) {
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

  // trailing country (name / alpha-2 / alpha-3) — in the tail slot a valid
  // ISO code wins over a US-state reading ('Toronto, Ontario, CA' -> Canada);
  // labels like 'X, County, GA' with a US-state tail do not occur as single
  // comma labels (only as list rows handled by the separators).
  if (parts.length >= 3) {
    const tail = parts[parts.length - 1];
    let c = country ?? normalizeCountryOnlyV2(tail);
    // a 2-letter tail that is BOTH a US state and an ISO country ('CA','GA','IL')
    // reads as the US state when the middle part itself contains a US-state code
    // ('Pueblo, CO Penrose, CO'); otherwise the country wins
    // ('Toronto, Ontario, CA' -> Canada).
    if (
      c &&
      /^[A-Za-z]{2}$/.test(tail) &&
      US_STATE_AND_TERRITORY_CODES.has(tail.toUpperCase()) &&
      parts.slice(0, -1).some((p) => /\b[A-Z]{2}\b/.test(p) && Boolean(normalizeUsStateV2(p.split(' ')[0])))
    ) {
      c = null;
    }
    if (!country && c) {
      country = c;
      parts.pop();
    }
  }

  // merged-blob label: parts as they stand with the country segment removed
  // but before any state/qualifier consumption ('Clarksburg, MD, United States'
  // -> 'Clarksburg, MD')
  const blob = dedupeConsecutive(parts).join(', ');

  // trailing US state
  let state: string | null = null;
  {
    const tail = parts[parts.length - 1];
    const st = tail ? normalizeUsStateV2(tail) : null;
    if (st && parts.length >= 2) {
      state = st;
      parts.pop();
    }
  }

  // 'City, Subdivision' — verbatim subdivision when not US/country
  if (parts.length === 2 && !state) {
    const [city, sub] = parts;
    const c = normalizeCountryOnlyV2(sub);
    if (c) {
      // 'NY, USA' — a US-state code in the city slot is a state, not a city
      if (US_STATE_AND_TERRITORY_CODES.has(city.toUpperCase())) {
        return {
          location: new LocationDto({
            state: city.toUpperCase(),
            country: c,
            name: asSiteName(siteName),
          }),
          firm: true,
          blob: city,
        };
      }
      return {
        location: new LocationDto({ city, country: c, name: asSiteName(siteName) }),
        firm: true,
        blob: city,
      };
    }
    // 'City, Remote' / 'City, Hybrid' — qualifier tail stays out of fields
    if (isWorkplaceQualifierOnlyV2(sub, true)) {
      return {
        location: new LocationDto({ city, country: country ?? undefined }),
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
          name: asSiteName([codeTail[2], siteName].filter(Boolean).join(' - ')),
          country: country ?? undefined,
        }),
        firm: true,
        blob,
      };
    }
    // site-descriptor tails are names, not subdivisions
    if (
      !QUALIFIER_WORD_RE.test(sub) &&
      /\b(?:hq|hqtrs|headquarters|office|campus|corp(?:orate)?|site|plant|services|pvt|ltd|inc|factory|facility|works|on-?site|onsite|offsite)\b/i.test(sub)
    ) {
      return {
        location: new LocationDto({
          city,
          name: asSiteName([sub, siteName].filter(Boolean).join(' - ')),
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
    if (isWorkplaceQualifierOnlyV2(only, true)) {
      if (!country) return null;
      return { location: new LocationDto({ country }), firm: true };
    }
    const c = normalizeCountryOnlyV2(only);
    if (c) {
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
      !state && !BARE_STATE_NAME_COLLISIONS.has(only.toLowerCase())
        ? normalizeUsStateV2(only)
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
    if (out.length && out[out.length - 1].toLowerCase() === p.toLowerCase()) continue;
    out.push(p);
  }
  return out;
}

/** Title-case bare-city candidate ('San Francisco', 'Bellevue', 'NYC'). */
function isBareCityCandidate(value: string): boolean {
  return /^[A-Z][A-Za-z.' -]*$/.test(value.trim());
}

/**
 * Split a label on word connectors ' & ' ' and ' ' or ' ' / ' (all require
 * spaces). Validation: every part must be a qualifier or a firm parse —
 * EXCEPT ' & ' / ' / ' which also allow a title-case bare city when some
 * other part is firm. ' and ' / ' or ' are stricter so entity names like
 * 'BMS Test and Trials' and 'Austin or Bryan' stay intact.
 */
function tryWordSplit(
  cleaned: string,
  options?: ParseLocationOptionsV2,
): string[] | null {
  // 'or'/'and' never split on an ALL-CAPS 2-letter token — 'Portland, OR / X'
  // must keep Oregon, not treat 'OR' as a connector
  const parts: string[] = [];
  const conns: string[] = [];
  const connRe = /(?<!\s)\s+(&|\/|and|or)\s+/gi;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = connRe.exec(cleaned))) {
    if (/^[A-Z]{2}$/.test(m[1])) continue; // 'OR' = Oregon, not a connector
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
    if (isWorkplaceQualifierOnlyV2(part, true)) {
      firm = true;
      continue;
    }
    const parsed = parseSingleLabel(part, options);
    if (parsed?.firm) {
      firm = true;
      continue;
    }
    const softOk =
      parsed && isBareCityCandidate(part) && (prevConn === '&' || prevConn === '/');
    if (!softOk) {
      failed = true;
      break;
    }
  }
  return !failed && firm ? parts : null;
}

/**
 * Comma-packed multi-site: 'Fremont, CA, Salem, OR, Pittsburgh, PA' (pairs) or
 * 'Bellevue, Washington, United States, Everett, Washington, United States'
 * (triples). Accepted only when every group parses firm.
 */
function tryCommaGroupSplit(
  cleaned: string,
  options?: ParseLocationOptionsV2,
): string[] | null {
  const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 4) return null;

  const width = parts.length % 3 === 0 ? 3 : parts.length % 2 === 0 ? 2 : 0;
  if (!width) return null;
  const groups: string[] = [];
  for (let i = 0; i < parts.length; i += width) {
    groups.push(parts.slice(i, i + width).join(', '));
  }
  const allFirm = groups.every((g) => {
    if (isWorkplaceQualifierOnlyV2(g, true)) return true;
    const parsed = parseSingleLabel(g, options);
    if (!parsed?.firm) return false;
    // pair groups additionally need a *recognized* subdivision — a verbatim
    // 'City, Subdivision' is too weak ('BMS Test and Trials, Pascagoula')
    if (width === 2) {
      return Boolean(
        (parsed.location.state && US_STATE_AND_TERRITORY_CODES.has(parsed.location.state)) ||
          parsed.location.country,
      );
    }
    return true;
  });
  return allFirm ? groups : null;
}

export function parseLocationListV2(
  rawLocations: Array<string | null | undefined>,
  options?: ParseLocationOptionsV2,
): ParsedLocationListV2 {
  const concrete: Array<{ location: LocationDto; label: string; key: string; blob?: string }> = [];
  const seen = new Set<string>();
  const countries = new Set<string>();
  let remoteMentioned = false;
  let workFromHomeType: WorkFromHomeType | null = null;

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
    const existingIdx = concrete.findIndex(
      (c) =>
        [c.location.city, c.location.state]
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .join('|')
          .toLowerCase() === csKey,
    );
    if (existingIdx >= 0) {
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
    concrete.push({ location: dto, label, key, blob });
  };

  const emit = (segment: string) => {
    if (isWorkplaceQualifierOnlyV2(segment, true)) return;
    // word separators first ('Denver, CO; San Francisco, CA' etc.)
    const wordParts = tryWordSplit(segment, options) ?? [segment];
    for (const wp of wordParts) {
      if (isWorkplaceQualifierOnlyV2(wp, true)) continue;
      // then comma-packed groups
      const groups = tryCommaGroupSplit(wp, options) ?? [wp];
      for (const g of groups) {
        if (isWorkplaceQualifierOnlyV2(g, true)) continue;
        const parsed = parseSingleLabel(g, options);
        if (!parsed) continue;
        if (parsed.location.country) countries.add(parsed.location.country);
        addEntry(g, parsed.location, parsed.blob);
      }
    }
  };

  for (const raw of rawLocations) {
    const normalized = raw?.replace(/\s+/g, ' ').trim() ?? '';
    if (!normalized) continue;

    const flags = remoteFlags(normalized);
    remoteMentioned = remoteMentioned || flags.remoteMentioned;
    workFromHomeType = mergeWorkFromHomeTypeV2(workFromHomeType, flags.workFromHomeType);

    if (isWorkplaceQualifierOnlyV2(normalized, true)) continue;

    // ';' and '|' are unambiguous list separators — split first, then extract
    for (const chunk of normalized.split(/\s*[;|]+\s*/)) {
      const cleaned = extractGeo(chunk.trim());
      if (cleaned) emit(cleaned);
    }
  }

  const filteredConcrete = concrete.filter(
    (item) =>
      !isBareCityDuplicateV2(
        item,
        concrete.map((candidate) => candidate.location),
      ),
  );
  const locations = filteredConcrete.map(({ location }) => location);
  const labels = filteredConcrete.map(({ label }) => label);

  /** implied country per entry: explicit country, or US-state code -> US. */
  const impliedCountry = (loc: LocationDto): string | null => {
    if (loc.country) return loc.country;
    if (loc.state && US_STATE_AND_TERRITORY_CODES.has(loc.state))
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
    .filter(({ location: l }) => l.city || l.state)
    .map((item) => item.blob ?? item.label);

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
    return { location, locations: [location], labels, remoteMentioned, workFromHomeType };
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

export function parseLocationTextV2(
  raw: string | null | undefined,
  options?: ParseLocationOptionsV2,
): ParsedLocationTextV2 {
  const normalized = raw?.replace(/\s+/g, ' ').trim() ?? '';
  if (!normalized) {
    return { location: null, remoteMentioned: false, workFromHomeType: null };
  }
  const flags = remoteFlags(normalized);
  const cleaned = extractGeo(normalized);
  const location = isWorkplaceQualifierOnlyV2(cleaned, true)
    ? null
    : parseSingleLabel(cleaned, options)?.location ?? null;
  return { location, ...flags };
}

function mergeWorkFromHomeTypeV2(
  current: WorkFromHomeType | null,
  next: WorkFromHomeType | null,
): WorkFromHomeType | null {
  if (!current) return next;
  if (!next || next === current) return current;
  return 'Hybrid or Remote';
}

function isBareCityDuplicateV2(
  item: { location: LocationDto; label: string },
  locations: LocationDto[],
): boolean {
  const city = item.location.city?.trim().toLowerCase();
  if (!city || item.location.state || item.location.country || item.label.includes(',')) {
    return false;
  }
  return locations.some(
    (candidate) =>
      candidate !== item.location &&
      candidate.city?.trim().toLowerCase() === city &&
      Boolean(candidate.state),
  );
}
