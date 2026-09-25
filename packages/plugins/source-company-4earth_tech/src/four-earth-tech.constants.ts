export const FOUR_EARTH_TECH_COMPANY_NAME = '4Earth';
export const FOUR_EARTH_TECH_ORIGIN = 'https://www.4earth.tech';
export const FOUR_EARTH_TECH_CAREERS_URL = `${FOUR_EARTH_TECH_ORIGIN}/careers`;
export const FOUR_EARTH_TECH_DEFAULT_TIMEOUT_SECONDS = 30;
/** Careers chunk referenced by the page shell (modulepreload link or script src). */
export const FOUR_EARTH_TECH_CHUNK_RE = /(?:src|href)="(\/assets\/Careers-[a-z0-9]+\.js)"/i;
/** Start of the embedded jobs array: `=[{id:"…"` — the binding name is minified. */
export const FOUR_EARTH_TECH_JOBS_ARRAY_RE = /=\s*\[\{id:/;
/**
 * Hosts a caller-supplied `companyUrl` may point at — mirrors the plugin's
 * `companyDomains` (Spec 1689). Anything else is ignored in favour of
 * {@link FOUR_EARTH_TECH_CAREERS_URL}.
 */
export const FOUR_EARTH_TECH_ALLOWED_HOSTS: readonly string[] = ['4earth.tech'];
/**
 * Largest bracket-balanced literal sliced out of the careers chunk (Spec
 * 1689). The chunk is third-party JS; a literal past this size is treated as
 * malformed rather than scanned and regex-matched in full.
 */
export const FOUR_EARTH_TECH_MAX_LITERAL_CHARS = 1_000_000;
