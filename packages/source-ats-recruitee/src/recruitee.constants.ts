/** Recruitee API base URL (slug is interpolated at runtime) */
export const RECRUITEE_API_BASE = 'https://{slug}.recruitee.com/api/offers';

/** Default headers for Recruitee API requests */
export const RECRUITEE_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};
