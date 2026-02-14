import { Country } from '@ever-jobs/models';

export const ADZUNA_API_BASE_URL = 'https://api.adzuna.com/v1/api/jobs';

export const ADZUNA_HEADERS: Record<string, string> = {
  Accept: 'application/json',
};

/**
 * Maximum results per page allowed by the Adzuna API.
 */
export const ADZUNA_MAX_PAGE_SIZE = 50;

/**
 * Default number of results to request.
 */
export const ADZUNA_DEFAULT_RESULTS = 25;

/**
 * Adzuna rate limits: 25 requests/minute, 250 requests/day.
 */
export const ADZUNA_RATE_LIMIT_PER_MINUTE = 25;
export const ADZUNA_RATE_LIMIT_PER_DAY = 250;

/**
 * Map Country enum values to Adzuna 2-letter country codes.
 */
export const COUNTRY_TO_ADZUNA: Partial<Record<Country, string>> = {
  [Country.UK]: 'gb',
  [Country.USA]: 'us',
  [Country.AUSTRALIA]: 'au',
  [Country.CANADA]: 'ca',
  [Country.GERMANY]: 'de',
  [Country.FRANCE]: 'fr',
  [Country.INDIA]: 'in',
  [Country.POLAND]: 'pl',
  [Country.BRAZIL]: 'br',
  [Country.AUSTRIA]: 'at',
  [Country.NEWZEALAND]: 'nz',
  [Country.SOUTHAFRICA]: 'za',
};

/**
 * Default Adzuna country code when no mapping is found.
 */
export const ADZUNA_DEFAULT_COUNTRY = 'us';
