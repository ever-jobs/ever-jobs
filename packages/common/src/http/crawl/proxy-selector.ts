import { ProxyRotation } from './types';

/** Mutable per-client rotation state. */
export interface ProxyRotationState {
  index: number;
  pinned?: string | null;
}

/**
 * Pick the proxy for one request, or null for a direct connection. A
 * `'localhost'` entry keeps its pre-1690 meaning (direct). Spec 1690 — lane B2.
 */
export function selectProxy(
  proxies: readonly string[],
  rotation: ProxyRotation,
  state: ProxyRotationState,
  bucketKey: string,
): string | null {
  throw new Error('not implemented (Spec 1690 lane B2)');
}
