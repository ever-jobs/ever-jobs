export const RDW_COMPANY_NAME = 'Redwire Corporation';
export const RDW_CAREERS_URL = 'https://rdw.com/careers/';
export const RDW_ORIGIN = 'https://careers.rdw.com';
export const RDW_SEARCH_PATH = '/jobs/search';

/** Registrable domain this plugin is allowed to navigate to. */
export const RDW_ALLOWED_HOST = 'rdw.com';

/**
 * `true` when `url` is an http(s) URL on {@link RDW_ALLOWED_HOST} or one of its
 * subdomains.
 *
 * Two untrusted values reach `page.goto`: the caller-supplied `companyUrl`, and
 * every `href` read off a fetched board page. Unchecked, either can point the
 * shared browser at an internal address, and this plugin copies the whole
 * detail page into `description`, so the response would carry back what it
 * read. Same shape hardened for `source-ats-submit4jobs` in #47 — fail closed,
 * so an unrecognised URL is skipped rather than fetched.
 *
 * Parsing with `URL` rather than matching the raw string is what rejects
 * `https://evil.com/x.rdw.com`, `https://user@evil.com#.rdw.com` and
 * `file:///etc/passwd`: `hostname` carries no credentials, port or path.
 */
export function isAllowedRdwUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return host === RDW_ALLOWED_HOST || host.endsWith(`.${RDW_ALLOWED_HOST}`);
}
export const RDW_DEFAULT_RESULTS = 50;
export const RDW_DEFAULT_TIMEOUT_SECONDS = 20;
export const RDW_DETAIL_CONCURRENCY = 5;
