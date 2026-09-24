import { RobotsDecision, RobotsTxtMode } from './types';

export type RobotsFetcher = (robotsUrl: string) => Promise<{ status: number; body: string } | null>;

/**
 * Per-origin robots.txt cache (LRU + TTL). A missing / 4xx / unreachable
 * robots.txt allows everything. Spec 1690 — implemented by lane B2.
 */
export class RobotsTxtCache {
  constructor(options?: { maxOrigins?: number; ttlMs?: number; now?: () => number }) {}

  check(url: string, userAgent: string, mode: RobotsTxtMode, fetcher: RobotsFetcher): Promise<RobotsDecision> {
    throw new Error('not implemented (Spec 1690 lane B2)');
  }
}

export function getRobotsTxtCache(): RobotsTxtCache {
  throw new Error('not implemented (Spec 1690 lane B2)');
}

export function resetRobotsTxtCache(cache?: RobotsTxtCache): void {
  throw new Error('not implemented (Spec 1690 lane B2)');
}
