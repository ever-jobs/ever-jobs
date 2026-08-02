import { LocationDto } from '@ever-jobs/models';

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

export interface ParseLocationOptions {
  /**
   * When true, a lone token that carries no city (no comma) but exactly matches
   * a known US state/territory **name** or **2-letter code** is classified as a
   * state-only location (e.g. `"Virginia"` / `"VA"` → `{ state: 'VA' }`) instead
   * of falling through to the `city` field. Off by default, so every existing
   * caller is unaffected. Named generically (state/province) so the opt-in can
   * later cover non-US subdivisions without another signature change.
   */
  allowBareStateProvince?: boolean;
}

/**
 * Conservatively split a plain US `City, ST` label.
 *
 * Recognized hybrid/remote qualifiers are returned separately so an exact US
 * `City, ST` remainder can be split without losing workplace information.
 * Unrecognized or unsafe formats remain intact in `city`.
 */
export function parseLocationText(
  raw: string | null | undefined,
  options?: ParseLocationOptions,
): ParsedLocationText {
  const normalized = raw?.replace(/\s+/g, ' ').trim() ?? '';
  if (!normalized) {
    return {
      location: null,
      remoteMentioned: false,
      workFromHomeType: null,
    };
  }

  const remoteMentioned = /\bremote\b/i.test(normalized);
  const hybridMentioned = /\bhybrid\b/i.test(normalized);
  const workFromHomeType = hybridMentioned
    ? remoteMentioned
      ? 'Hybrid or Remote'
      : 'Hybrid'
    : remoteMentioned
      ? 'Remote'
      : null;

  let geographicText = normalized.replace(
    /\(([^()]*)\)/g,
    (whole, content: string) =>
      isWorkplaceQualifierOnly(content, true) ? ' ' : whole,
  );
  geographicText = geographicText.replace(/\s+/g, ' ').trim();

  const hasSlashDelimiter = geographicText.includes('/');
  const slashParts = geographicText
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (hasSlashDelimiter) {
    const geographicParts = slashParts.filter(
      (part) => !isWorkplaceQualifierOnly(part, false),
    );
    if (geographicParts.length === 1) geographicText = geographicParts[0];
  }

  const match = /^([^,/()]+),\s*([A-Z]{2})$/i.exec(geographicText);
  const state = match?.[2].toUpperCase();

  if (
    match &&
    state &&
    US_STATE_AND_TERRITORY_CODES.has(state)
  ) {
    return {
      location: new LocationDto({ city: match[1].trim(), state }),
      remoteMentioned,
      workFromHomeType,
    };
  }

  if (options?.allowBareStateProvince && !geographicText.includes(',')) {
    const bareState = normalizeUsState(geographicText);
    if (bareState) {
      return {
        location: new LocationDto({ state: bareState }),
        remoteMentioned,
        workFromHomeType,
      };
    }
  }

  return {
    location: new LocationDto({ city: normalized }),
    remoteMentioned,
    workFromHomeType,
  };
}

/**
 * Normalize an ordered list of location labels into the current singular DTO
 * shape plus parsed internals for callers that need to reason about all
 * concrete locations.
 */
export function parseLocationList(
  rawLocations: Array<string | null | undefined>,
  options?: ParseLocationOptions,
): ParsedLocationList {
  const concrete: Array<{ location: LocationDto; label: string; key: string }> = [];
  const seen = new Set<string>();
  const countries = new Set<string>();
  let remoteMentioned = false;
  let workFromHomeType: WorkFromHomeType | null = null;

  for (const raw of rawLocations) {
    const normalized = raw?.replace(/\s+/g, ' ').trim() ?? '';
    if (!normalized) continue;

    const parsed = parseLocationText(normalized, options);
    remoteMentioned = remoteMentioned || parsed.remoteMentioned;
    workFromHomeType = mergeWorkFromHomeType(
      workFromHomeType,
      parsed.workFromHomeType,
    );

    if (isWorkplaceQualifierOnly(normalized, true)) {
      continue;
    }

    const country = normalizeCountryOnly(normalized);
    if (country) {
      countries.add(country);
      continue;
    }

    const canonical = canonicalUsLocation(normalized);
    const location = canonical?.location ?? parsed.location;
    if (!location) continue;

    const locationCountry =
      typeof location.country === 'string' && location.country.trim()
        ? location.country.trim()
        : null;
    if (locationCountry) countries.add(locationCountry);

    const label =
      canonical?.label ??
      [location.city, location.state, location.country]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join(', ');
    const key =
      canonical?.key ??
      [location.city, location.state, location.country]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join('|')
        .toLowerCase();

    if (!label || seen.has(key)) continue;
    seen.add(key);
    concrete.push({ location, label, key });
  }

  const filteredConcrete = concrete.filter(
    (item) =>
      !isBareCityDuplicate(
        item,
        concrete.map((candidate) => candidate.location),
      ),
  );
  const commonCountry = countries.size === 1 ? [...countries][0] : null;
  const locations = filteredConcrete.map(({ location }) => location);
  const labels = filteredConcrete.map(({ label }) => label);

  if (locations.length === 0) {
    return {
      location: remoteMentioned
        ? new LocationDto({ city: 'Remote', country: commonCountry })
        : commonCountry
          ? new LocationDto({ country: commonCountry })
          : null,
      locations,
      labels,
      remoteMentioned,
      workFromHomeType,
    };
  }

  if (locations.length === 1) {
    const location = new LocationDto({
      ...locations[0],
      country: locations[0].country ?? commonCountry,
    });
    return { location, locations: [location], labels, remoteMentioned, workFromHomeType };
  }

  return {
    location: new LocationDto({
      city: labels.join('; '),
      country: commonCountry,
    }),
    locations,
    labels,
    remoteMentioned,
    workFromHomeType,
  };
}

function isWorkplaceQualifierOnly(
  value: string,
  allowSlash: boolean,
): boolean {
  if (!/\b(?:hybrid|remote)\b/i.test(value)) return false;

  const withoutWords = value.replace(
    /\b(?:hybrid|remote|and|or)\b/gi,
    '',
  );
  const allowedSeparators = allowSlash ? /^[\s/&,+-]*$/ : /^[\s&,+-]*$/;
  return allowedSeparators.test(withoutWords);
}

function canonicalUsLocation(
  value: string,
): { location: LocationDto; label: string; key: string } | null {
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;

  const city = parts[0];
  const state = normalizeUsState(parts[1]);
  if (!city || !state) return null;

  const country = parts[2] ? normalizeCountryOnly(parts[2]) : null;
  if (parts[2] && !country) return null;

  const location = new LocationDto({
    city,
    state,
    country: country ?? undefined,
  });
  return {
    location,
    label: `${city}, ${state}`,
    key: `${city.toLowerCase()}|${state}`,
  };
}

function normalizeUsState(value: string): string | null {
  const code = value.trim().toUpperCase();
  if (US_STATE_AND_TERRITORY_CODES.has(code)) return code;
  return US_STATE_NAME_TO_CODE[value.trim().toLowerCase()] ?? null;
}

function normalizeCountryOnly(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\./g, '');
  if (['united states', 'united states of america', 'usa', 'us'].includes(normalized)) {
    return 'United States';
  }
  return null;
}

function mergeWorkFromHomeType(
  current: WorkFromHomeType | null,
  next: WorkFromHomeType | null,
): WorkFromHomeType | null {
  if (!current) return next;
  if (!next || next === current) return current;
  return 'Hybrid or Remote';
}

function isBareCityDuplicate(
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
