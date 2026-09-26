export const THINKORBITAL_COMPANY_NAME = 'ThinkOrbital';
export const THINKORBITAL_ORIGIN = 'https://thinkorbital.com';
export const THINKORBITAL_CAREERS_URL = `${THINKORBITAL_ORIGIN}/careers/`;
export const THINKORBITAL_DEFAULT_RESULTS = 50;
export const THINKORBITAL_DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Env toggle for ThinkOrbital's location heuristics (Spec 1689), layered on
 * top of the shared parser: a missing country is filled with `Country.USA`
 * (ThinkOrbital hires in the US only) and a US state named anywhere after the
 * city ("Boulder, Colorado or Washington, DC Area") fills a missing state.
 * `false` / `0` / `off` / `no` → shared-parser output only (Spec 5125
 * literal-only); unset or anything else → heuristics on (pre-5125 data).
 */
export const THINKORBITAL_LOCATION_HEURISTICS_ENV = 'THINKORBITAL_LOCATION_HEURISTICS';

export function thinkorbitalLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[THINKORBITAL_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
