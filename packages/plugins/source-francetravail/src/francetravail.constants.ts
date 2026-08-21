export const FRANCETRAVAIL_API_URL = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search';
export const FRANCETRAVAIL_TOKEN_URL = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=/partenaire';
export const FRANCETRAVAIL_DEFAULT_RESULTS = 25;
export const FRANCETRAVAIL_MAX_RESULTS = 50;
/**
 * Auth-token fetch budget, in SECONDS -- createHttpClient multiplies by 1000.
 * Spelled out in the name because the option itself is unit-ambiguous.
 */
export const FRANCETRAVAIL_TOKEN_TIMEOUT_SECONDS = 10;

export const FRANCETRAVAIL_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent': 'EverJobs/1.0',
};
