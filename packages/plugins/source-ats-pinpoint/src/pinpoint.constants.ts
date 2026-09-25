/**
 * Env toggle for Pinpoint location heuristics (Spec 1689), layered on top of
 * the shared parser: when a structured location carries only a `province`
 * (no `name` / `city`), the province is also used as the city label — the
 * pre-5125 `name ?? city ?? province` fallback. `false` / `0` / `off` / `no`
 * → shared-parser output only (province kept in `state` alone); unset or
 * anything else → heuristics on.
 */
export const PINPOINT_LOCATION_HEURISTICS_ENV = 'PINPOINT_LOCATION_HEURISTICS';

export function pinpointLocationHeuristicsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[PINPOINT_LOCATION_HEURISTICS_ENV] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}
