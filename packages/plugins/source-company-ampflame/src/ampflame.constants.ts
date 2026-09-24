export const AMPFLAME_COMPANY_NAME = 'Accurate Metals';
export const AMPFLAME_ORIGIN = 'https://ampflame.com';
export const AMPFLAME_CAREERS_URL = `${AMPFLAME_ORIGIN}/about/`;
export const AMPFLAME_DEFAULT_TIMEOUT_SECONDS = 30;
/**
 * Hosts a caller-supplied `companyUrl` may point at — mirrors the plugin's
 * `companyDomains` (Spec 1689). Anything else is ignored in favour of
 * {@link AMPFLAME_CAREERS_URL}.
 */
export const AMPFLAME_ALLOWED_HOSTS: readonly string[] = ['ampflame.com'];
/** Next.js careers table — ARIA attrs are stable; class names are hashed CSS modules. */
export const AMPFLAME_TABLE_SELECTOR = 'div[role="table"][aria-label="Open positions"]';
export const AMPFLAME_ROW_SELECTOR = 'div[role="row"]';
export const AMPFLAME_CELL_SELECTOR = 'span[role="cell"][data-label]';
