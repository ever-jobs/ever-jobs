export const MUNDANE_COMPANY_NAME = 'Mundane';
export const MUNDANE_ORIGIN = 'https://mundane.co';
export const MUNDANE_JOIN_URL = `${MUNDANE_ORIGIN}/join-us`;
export const MUNDANE_DEFAULT_TIMEOUT_SECONDS = 30;
/** Let the Airtable shared form hydrate before reading the DOM. */
export const MUNDANE_AIRTABLE_HYDRATE_MS = 2500;
/** Cap on per-job Airtable renders so a large board stays bounded. */
export const MUNDANE_MAX_DETAIL_RENDERS = 25;
/**
 * Job entries embedded in the site bundle look like
 * `{title:"…",category:"…",location:"…",url:"…"}`; the array identifier is
 * minified per deploy, so entries are matched by field shape and an
 * apply-URL host (Airtable shared forms or LinkedIn job posts).
 */
export const MUNDANE_JOB_ENTRY_RE =
  /\{title:"((?:[^"\\]|\\.)*)",category:"((?:[^"\\]|\\.)*)",location:"((?:[^"\\]|\\.)*)",url:"((?:[^"\\]|\\.)*)"\}/g;
/**
 * @deprecated Unanchored — `http://10.0.0.5/airtable.com/x` passes it. Kept
 * for importers; the service matches on the parsed hostname against
 * {@link MUNDANE_APPLY_HOSTS} instead (Spec 1689).
 */
export const MUNDANE_APPLY_HOST_RE = /(?:airtable\.com|linkedin\.com)\//;
/**
 * Apply-link hosts that mark a bundle entry as a job (Spec 1689). Compared
 * against `new URL(url).hostname`: the host itself or a subdomain of it.
 */
export const MUNDANE_APPLY_HOSTS: readonly string[] = ['airtable.com', 'linkedin.com'];
/** Hosts whose shared forms may be opened in the browser for descriptions. */
export const MUNDANE_AIRTABLE_HOSTS: readonly string[] = ['airtable.com'];
/**
 * Hosts a caller-supplied `companyUrl` may point at — mirrors the plugin's
 * `companyDomains` (Spec 1689). Anything else is ignored in favour of
 * {@link MUNDANE_JOIN_URL}.
 */
export const MUNDANE_ALLOWED_HOSTS: readonly string[] = ['mundane.co'];
/**
 * Env switch for the fork's original behaviour of shutting the whole shared
 * Chromium pool down at the end of every scrape. Off by default (Spec
 * 1689): `BrowserPool` is process-global, so
 * closing it kills every other plugin's in-flight browser scrape. Set to
 * `true` only on a worker that runs Mundane alone and must free the browser
 * between runs. The pool is always closed on module destroy.
 */
export const MUNDANE_CLOSE_BROWSER_POOL_ENV = 'MUNDANE_CO_CLOSE_BROWSER_POOL_AFTER_SCRAPE';

/** Whether {@link MUNDANE_CLOSE_BROWSER_POOL_ENV} asks for the old per-scrape pool shutdown. */
export function readMundaneClosePoolAfterScrape(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[MUNDANE_CLOSE_BROWSER_POOL_ENV] ?? '').trim().toLowerCase() === 'true';
}
