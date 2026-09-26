export const ARGOSPACE_COMPANY_NAME = 'Argo Space';
export const ARGOSPACE_ORIGIN = 'https://argospace.com';
export const ARGOSPACE_CAREERS_URL = `${ARGOSPACE_ORIGIN}/careers`;
export const ARGOSPACE_DEFAULT_RESULTS = 50;
export const ARGOSPACE_DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Env toggle for Argo Space location heuristics (Spec 1689), layered on top of
 * the shared parser: parenthetical qualifiers ("El Segundo, CA (On-site)") are
 * stripped before parsing and a missing country is filled with `Country.USA`
 * (Argo Space hires in the US only) — the pre-5125 behaviour. `false` / `0` /
 * `off` / `no` → shared-parser output only (Spec 5125 literal-only); unset or
 * anything else → heuristics on.
 */
export const ARGOSPACE_LOCATION_HEURISTICS_ENV = 'ARGOSPACE_LOCATION_HEURISTICS';

export function argospaceLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[ARGOSPACE_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
