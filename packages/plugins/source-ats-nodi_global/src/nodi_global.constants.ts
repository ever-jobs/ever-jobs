/**
 * Constants for the Nodi (nodi.global) careers-board scraper.
 *
 * Nodi is a multi-tenant ATS: each company gets a public board at
 * `https://app.nodi.global/company/<slug>` rendered by a Next.js app, but the
 * board data comes from a public JSON API — no browser needed:
 *
 *   1. GET `https://api.nodi.global/job-offers/active/company/<slug>` —
 *      array of full offer records (title, location, department, type,
 *      modality, seniority, salary range, HTML description, magic_link).
 *   2. GET `https://api.nodi.global/companies/by-name?name=<slug>` —
 *      company name + website (display metadata only).
 *
 * `magic_link` is the public job page (`app.nodi.global/jobs/public/<id>`).
 * The company page's SSR HTML renders a "0 positions" skeleton before
 * hydration, so parsing the board page itself is not viable — the API is
 * authoritative.
 */

export const NODI_GLOBAL_API_ORIGIN = 'https://api.nodi.global';

export const NODI_GLOBAL_DEFAULT_TIMEOUT_SECONDS = 30;

export function nodiGlobalJobsUrl(slug: string): string {
  return `${NODI_GLOBAL_API_ORIGIN}/job-offers/active/company/${encodeURIComponent(slug)}`;
}

export function nodiGlobalCompanyUrl(slug: string): string {
  return `${NODI_GLOBAL_API_ORIGIN}/companies/by-name?name=${encodeURIComponent(slug)}`;
}
