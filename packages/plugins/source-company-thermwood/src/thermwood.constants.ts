export const THERMWOOD_COMPANY_NAME = 'Thermwood';
export const THERMWOOD_ORIGIN = 'https://www.thermwood.com';
export const THERMWOOD_CAREERS_URL = `${THERMWOOD_ORIGIN}/employment-opportunities.htm`;
export const THERMWOOD_DEFAULT_TIMEOUT_SECONDS = 30;
/**
 * Hosts a caller-supplied `companyUrl` may point at — mirrors the plugin's
 * `companyDomains` (Spec 1689). Anything else is ignored in favour of
 * {@link THERMWOOD_CAREERS_URL}.
 */
export const THERMWOOD_ALLOWED_HOSTS: readonly string[] = ['thermwood.com'];
export const THERMWOOD_CARD_SELECTOR = 'div.job-card';
export const THERMWOOD_TITLE_SELECTOR = 'h3.job-card-title';
export const THERMWOOD_DATE_SELECTOR = '.job-card-date';
export const THERMWOOD_LOCATION_SELECTOR = '.job-card-location';
export const THERMWOOD_DETAILS_SELECTOR = '.job-card-details';
