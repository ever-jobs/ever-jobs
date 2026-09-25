export const TAU_ROBOTICS_COMPANY_NAME = 'Tau Robotics';
export const TAU_ROBOTICS_ORIGIN = 'https://www.tau-robotics.com';
export const TAU_ROBOTICS_CAREERS_URL = `${TAU_ROBOTICS_ORIGIN}/careers`;
export const TAU_ROBOTICS_APPLY_JS_URL = `${TAU_ROBOTICS_ORIGIN}/apply.js`;
export const TAU_ROBOTICS_DEFAULT_TIMEOUT_SECONDS = 30;

/** Slug of the generic "don't see a role?" link — not a real posting. */
export const TAU_ROBOTICS_SKIP_SLUGS = new Set(['open-application']);

/**
 * Hosts a caller-supplied `companyUrl` may point at — mirrors the plugin's
 * `companyDomains` (Spec 1689). Anything else is ignored in favour of
 * {@link TAU_ROBOTICS_CAREERS_URL}.
 */
export const TAU_ROBOTICS_ALLOWED_HOSTS: readonly string[] = ['tau-robotics.com'];

/**
 * Largest brace- or bracket-balanced literal sliced out of apply.js (Spec
 * 1689). apply.js is third-party JS; a literal past this size is treated as
 * malformed rather than scanned in full.
 */
export const TAU_ROBOTICS_MAX_LITERAL_CHARS = 1_000_000;
