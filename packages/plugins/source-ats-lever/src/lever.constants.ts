/** Lever API base URL */
export const LEVER_API_URL = 'https://api.lever.co/v0/postings';

/** Default headers for Lever API requests */
export const LEVER_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Safari/537.36',
};

/** Delay between requests in milliseconds */
export const LEVER_DELAY_MS = 1000;

/**
 * Env var controlling the ATS country overlay (Spec 1689).
 *
 * Lever carries a posting-level ISO-2 `country` code. Spec 5118 moved it to
 * `JobPostDto.countryCode` only, which dropped it from `location.country` —
 * and so from canonical records, canonical keys and every consumer that reads
 * the parsed location. The overlay restores the pre-5118 behaviour: when the
 * parser found no country, `location.country` is filled from the code (as its
 * CLDR display name, e.g. "NL" -> "Netherlands"). A parsed country is never
 * overwritten, and `countryCode` is emitted either way.
 *
 * Default ON. Set to `false` / `0` / `no` / `off` to get the Spec 5118
 * behaviour (code in `countryCode` only).
 */
export const ATS_COUNTRY_OVERLAY_ENV_VAR = 'EVER_JOBS_ATS_COUNTRY_OVERLAY';

const OVERLAY_OFF_VALUES = new Set(['false', '0', 'no', 'off']);

/** Read {@link ATS_COUNTRY_OVERLAY_ENV_VAR}; unset or unrecognised means ON. */
export function readAtsCountryOverlay(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ATS_COUNTRY_OVERLAY_ENV_VAR]?.trim().toLowerCase();
  if (!raw) return true;
  return !OVERLAY_OFF_VALUES.has(raw);
}
