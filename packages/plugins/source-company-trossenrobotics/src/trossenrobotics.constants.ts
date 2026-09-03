export const TROSSENROBOTICS_COMPANY_NAME = 'Trossen Robotics';
export const TROSSENROBOTICS_ORIGIN = 'https://www.trossenrobotics.com';
export const TROSSENROBOTICS_CAREERS_URL = `${TROSSENROBOTICS_ORIGIN}/careers`;
export const TROSSENROBOTICS_DEFAULT_RESULTS = 50;
export const TROSSENROBOTICS_DEFAULT_TIMEOUT_SECONDS = 30;
export const TROSSENROBOTICS_READY_TIMEOUT_SECONDS = 12;
export const TROSSENROBOTICS_DETAIL_READY_SECONDS = 8;
export const TROSSENROBOTICS_LIST_SELECTOR = 'main section a[aria-label="Learn More and Apply"]';

/** Registrable domain this plugin is allowed to navigate to. */
export const TROSSENROBOTICS_ALLOWED_HOST = 'trossenrobotics.com';

/**
 * `true` when `url` is an http(s) URL on {@link TROSSENROBOTICS_ALLOWED_HOST} or
 * one of its subdomains.
 *
 * Two untrusted values reach `page.goto`: the caller-supplied `companyUrl`, and
 * every `href` read off a fetched careers page. Unchecked, either can point the
 * shared headful browser at an internal address — and `extractDescription`
 * falls back to the whole `<body>` of whatever was fetched, so the response
 * would carry back what it read. Same shape hardened for
 * `source-ats-submit4jobs` in #47 — fail closed, so an unrecognised URL is
 * skipped rather than fetched.
 *
 * Parsing with `URL` rather than matching the raw string is what rejects
 * `https://evil.com/x.trossenrobotics.com`,
 * `https://user@evil.com#.trossenrobotics.com` and `file:///etc/passwd`:
 * `hostname` carries no credentials, port or path.
 */
export function isAllowedTrossenroboticsUrl(url: string): boolean {
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
  return (
    host === TROSSENROBOTICS_ALLOWED_HOST ||
    host.endsWith(`.${TROSSENROBOTICS_ALLOWED_HOST}`)
  );
}