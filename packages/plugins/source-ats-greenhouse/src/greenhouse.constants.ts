/** Greenhouse public job board API base URL */
export const GREENHOUSE_API_URL = 'https://api.greenhouse.io/v1/boards';

/** Greenhouse Harvest (authenticated) API base URL */
export const GREENHOUSE_HARVEST_API_URL = 'https://harvest.greenhouse.io/v1';

/** Default headers for Greenhouse API requests */
export const GREENHOUSE_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};

/** Env var holding an operator's Greenhouse Harvest API key. */
export const GREENHOUSE_API_KEY_ENV_VAR = 'GREENHOUSE_API_KEY';

/**
 * Env var naming the board token the env Harvest key belongs to (Spec 1735
 * §4.5). Harvest lists the key owner's jobs whatever board is requested, so
 * the env key is used only when the requested `companySlug` is this board.
 */
export const GREENHOUSE_HARVEST_BOARD_ENV_VAR = 'GREENHOUSE_HARVEST_BOARD';
