/** SmartRecruiters API base URL */
export const SMARTRECRUITERS_API_URL = 'https://api.smartrecruiters.com/v1/companies';

/**
 * Host of the public, human-facing posting pages (Spec 1750). A posting is
 * served at `${SMARTRECRUITERS_PUBLIC_JOBS_URL}/<companyIdentifier>/<postingId>`
 * (the API's own `postingUrl` appends a title slug to the same path). This —
 * never the API's `ref` resource — is what `jobUrl` carries.
 */
export const SMARTRECRUITERS_PUBLIC_JOBS_URL = 'https://jobs.smartrecruiters.com';

/** Default headers for SmartRecruiters API requests */
export const SMARTRECRUITERS_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};

/** Default page size for paginated requests */
export const SMARTRECRUITERS_PAGE_SIZE = 100;
