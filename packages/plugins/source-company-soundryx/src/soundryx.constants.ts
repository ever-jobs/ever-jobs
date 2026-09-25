export const SOUNDRYX_COMPANY_NAME = 'Soundryx';
export const SOUNDRYX_ORIGIN = 'https://soundryx.com';
export const SOUNDRYX_CAREERS_URL = `${SOUNDRYX_ORIGIN}/careers/`;
export const SOUNDRYX_DEFAULT_TIMEOUT_SECONDS = 30;
/**
 * Hosts this plugin may fetch — mirrors `companyDomains` (Spec 1689). A
 * caller-supplied `companyUrl` elsewhere is ignored in favour of
 * {@link SOUNDRYX_CAREERS_URL}, and index tiles linking elsewhere are skipped.
 */
export const SOUNDRYX_ALLOWED_HOSTS: readonly string[] = ['soundryx.com'];
/** Careers index tiles: `a.srx-tile.is-link` → `href="/careers/NNNNN-slug/"`. */
export const SOUNDRYX_TILE_SELECTOR = 'a.srx-tile.is-link';
export const SOUNDRYX_TILE_TITLE_SELECTOR = 'h3';
/** Detail-page content container. */
export const SOUNDRYX_DOC_SELECTOR = '.vp-doc';
/** `<p><strong>Location</strong>: Los Angeles, CA (onsite)</p>`. */
export const SOUNDRYX_LOCATION_RE = /^\s*location\s*$/i;
export const SOUNDRYX_ONSITE_RE = /\(\s*onsite\s*\)/i;
export const SOUNDRYX_COMPENSATION_HEADING_RE = /^compensation$/i;
export const SOUNDRYX_APPLY_HEADING_RE = /^apply\s+now$/i;
/** Cloudflare email protection: `data-cfemail` / `/cdn-cgi/l/email-protection#hex`. */
export const SOUNDRYX_CFEMAIL_ATTR = 'data-cfemail';
export const SOUNDRYX_CFEMAIL_SELECTOR = '.__cf_email__';
export const SOUNDRYX_CFEMAIL_HREF_RE = /email-protection#([0-9a-f]+)/i;
/** Footnotes block stripped from the description. */
export const SOUNDRYX_FOOTNOTES_SELECTOR = 'section.footnotes';
