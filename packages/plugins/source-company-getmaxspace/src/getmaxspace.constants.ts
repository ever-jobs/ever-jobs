export const GETMAXSPACE_COMPANY_NAME = 'Max Space';
export const GETMAXSPACE_ORIGIN = 'https://www.getmaxspace.com';
export const GETMAXSPACE_CAREERS_URL = `${GETMAXSPACE_ORIGIN}/careers`;
export const GETMAXSPACE_DEFAULT_TIMEOUT_SECONDS = 30;
/**
 * Hosts a caller-supplied `companyUrl` may point at — mirrors the plugin's
 * `companyDomains` (Spec 1689). Anything else is ignored in favour of
 * {@link GETMAXSPACE_CAREERS_URL}.
 */
export const GETMAXSPACE_ALLOWED_HOSTS: readonly string[] = ['getmaxspace.com'];
/** Webflow CMS collection item: one anchor per role. */
export const GETMAXSPACE_ITEM_SELECTOR = 'a.career-jobs_cms-link';
/** Column divs inside the item: is-1 title, is-2 dept, is-3 type, is-4 location, is-5 icon. */
export const GETMAXSPACE_COL_SELECTOR = '.career-jobs_list-title';
