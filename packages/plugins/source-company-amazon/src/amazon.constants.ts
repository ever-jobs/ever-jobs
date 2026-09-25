export const AMAZON_API_URL = 'https://www.amazon.jobs/api/jobs/search';

export const AMAZON_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'Accept-Encoding': 'identity',
  'User-Agent': 'Mozilla/5.0',
};

export const AMAZON_PAGE_SIZE = 25;
export const AMAZON_MAX_RETRIES = 3;
export const AMAZON_REQUEST_DELAY_MS = 500;

/**
 * Env toggle for Amazon's country inference (Spec 1689), layered on top of the
 * shared parser: a label whose state is a US state code ("Seattle, WA") gets
 * `US` as its country — the pre-5125 `?? 'US'` default, now limited to labels
 * that are evidently US (Amazon hires worldwide, so a blanket default would
 * mislabel "Bangalore, KA"). `false` / `0` / `off` / `no` → shared-parser
 * output only (Spec 5125 literal-only); unset or anything else → on.
 */
export const AMAZON_LOCATION_HEURISTICS_ENV = 'AMAZON_LOCATION_HEURISTICS';

export function amazonLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[AMAZON_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
