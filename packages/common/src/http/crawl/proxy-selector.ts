import { ProxyRotation } from './types';

/** Mutable per-client rotation state. */
export interface ProxyRotationState {
  index: number;
  pinned?: string | null;
  /**
   * Where a `per-scrape` client's one pick starts in the list (taken modulo its
   * length). Unset = `index`. `createProxyRotationState()` spreads new clients
   * over the list so N scrapes do not all pin entry 0.
   */
  scrapeSeed?: number;
}

/**
 * The `per-scrape` proxy pin of one scrape (Spec 1690 §4.4), shared by every
 * `HttpClient` the scrape uses — `runWithScrapeContext` creates one per scrape
 * (`ScrapeContext.proxyPin`), so a plugin that builds a token client and a data
 * client keeps one origin for the whole scrape. Mutable; treat as opaque.
 */
export interface ScrapeProxyPin {
  /** Where this scrape's pick starts in a list (taken at its first `per-scrape` pick). */
  seed?: number;
  /**
   * Rotation state per proxy list (keyed by the list): clients given different
   * lists (a caller's vs the env's) each stay within their own, from the same seed.
   */
  states?: Map<string, ProxyRotationState>;
}

/** Process-wide counter seeding per-client `per-scrape` picks (one step per new client). */
let scrapeSeedCounter = 0;
/**
 * Process-wide counter seeding the pins of scrape contexts (one step per scrape
 * that picks). Separate from the client counter: a scrape builds any number of
 * clients, which must not skew how scrapes are spread over the list.
 */
let scrapePinSeedCounter = 0;

/**
 * Fresh rotation state for one client. `per-request` still starts at entry 0
 * (pre-1690); outside any scrape context a `per-scrape` client pins the entry
 * after the one the previous client pinned, so the list is used evenly.
 */
export function createProxyRotationState(): ProxyRotationState {
  const scrapeSeed = scrapeSeedCounter;
  scrapeSeedCounter = (scrapeSeedCounter + 1) % Number.MAX_SAFE_INTEGER;
  return { index: 0, scrapeSeed };
}

/** An empty pin for one scrape (`runWithScrapeContext`); the seed is taken lazily. */
export function createScrapeProxyPin(): ScrapeProxyPin {
  return {};
}

/** Distinct proxy lists remembered per scrape (a plugin uses one or two). */
const MAX_LISTS_PER_SCRAPE = 16;

/**
 * The rotation state a `per-scrape` pick of `proxies` uses inside the scrape that
 * owns `pin`: one per distinct list, all seeded with the scrape's seed (one step
 * of a process-wide counter per scrape, so successive scrapes are spread over
 * the list). Every client of the scrape that picks from the same list therefore
 * gets the same proxy.
 */
export function scrapeProxyRotationState(pin: ScrapeProxyPin, proxies: readonly string[]): ProxyRotationState {
  const states = pin.states ?? (pin.states = new Map());
  const key = JSON.stringify(proxies ?? []);
  let state = states.get(key);
  if (!state) {
    if (pin.seed === undefined) {
      pin.seed = scrapePinSeedCounter;
      scrapePinSeedCounter = (scrapePinSeedCounter + 1) % Number.MAX_SAFE_INTEGER;
    }
    if (states.size >= MAX_LISTS_PER_SCRAPE) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined) states.delete(oldest);
    }
    state = { index: 0, scrapeSeed: pin.seed };
    states.set(key, state);
  }
  return state;
}

/** Restart the `per-scrape` seed sequences — per client and per scrape context (tests). */
export function resetProxyScrapeSeed(value = 0): void {
  scrapeSeedCounter = Number.isInteger(value) && value >= 0 ? value : 0;
  scrapePinSeedCounter = scrapeSeedCounter;
}

/**
 * 32-bit FNV-1a over the UTF-8 bytes of `input` — a small, stable, well-spread
 * hash, so `per-host` rotation maps a bucket to the same proxy in every process
 * and across restarts (as long as the proxy list is unchanged).
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(input, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Pre-1690 meaning of a list entry: an empty entry or `'localhost'` means "no
 * proxy" (direct connection) — `HttpClient` used to skip the agent for both.
 */
function toProxy(entry: string | undefined): string | null {
  if (!entry || entry === 'localhost') return null;
  return entry;
}

/** The next entry in round-robin order (the pre-1690 `getNextProxy`). */
function nextRoundRobin(proxies: readonly string[], state: ProxyRotationState): string | undefined {
  const index = Number.isInteger(state.index) && state.index >= 0 ? state.index : 0;
  const entry = proxies[index % proxies.length];
  state.index = index + 1;
  return entry;
}

/**
 * Pick the proxy for one request, or null for a direct connection
 * (Spec 1690 §4.4). A `'localhost'` (or empty) entry keeps its pre-1690
 * meaning: direct.
 *
 * - `per-request`: round-robin on every call, starting at entry 0 of each new
 *   state — byte-for-byte the pre-1690 `HttpClient.getNextProxy()`.
 * - `per-scrape`: the first call picks entry `state.scrapeSeed` (else
 *   `state.index`), modulo the list length, and pins it in `state.pinned`; every
 *   later call returns the pin (even a pinned `null`, i.e. a direct connection).
 *   `HttpClient` passes the scrape's shared state (`scrapeProxyRotationState`)
 *   inside a scrape context, its own per-client state outside one.
 * - `per-host` (default): `proxies[fnv1a32(bucketKey) % length]` — one stable
 *   origin per rate-limit bucket, process wide. `state` is not touched.
 * - `off`: always null, whatever the list holds.
 *
 * An empty list is always a direct connection.
 */
export function selectProxy(
  proxies: readonly string[],
  rotation: ProxyRotation,
  state: ProxyRotationState,
  bucketKey: string,
): string | null {
  if (rotation === 'off' || !proxies || proxies.length === 0) return null;

  switch (rotation) {
    case 'per-request':
      return toProxy(nextRoundRobin(proxies, state));
    case 'per-scrape': {
      if (state.pinned !== undefined) return state.pinned;
      const seed = state.scrapeSeed;
      state.pinned =
        Number.isInteger(seed) && (seed as number) >= 0
          ? toProxy(proxies[(seed as number) % proxies.length])
          : toProxy(nextRoundRobin(proxies, state));
      return state.pinned;
    }
    case 'per-host':
    default:
      return toProxy(proxies[fnv1a32(bucketKey ?? '') % proxies.length]);
  }
}
