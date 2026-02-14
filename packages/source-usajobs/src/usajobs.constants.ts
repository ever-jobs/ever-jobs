export const USAJOBS_API_URL = 'https://data.usajobs.gov/api/Search';

export const USAJOBS_HEADERS: Record<string, string> = {
  Host: 'data.usajobs.gov',
  Accept: 'application/json',
};

/**
 * Maximum results per page allowed by the USAJobs API.
 */
export const USAJOBS_MAX_PAGE_SIZE = 500;

/**
 * Default number of results to request.
 */
export const USAJOBS_DEFAULT_RESULTS = 25;
