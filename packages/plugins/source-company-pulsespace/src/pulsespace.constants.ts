export const PULSESPACE_COMPANY_NAME = 'Pulse Space';
export const PULSESPACE_ORIGIN = 'https://pulsespace.com';
export const PULSESPACE_CAREERS_URL = `${PULSESPACE_ORIGIN}/careers`;
export const PULSESPACE_DEFAULT_RESULTS = 50;
export const PULSESPACE_DEFAULT_TIMEOUT_SECONDS = 30;
export const PULSESPACE_READY_TIMEOUT_SECONDS = 15;
// The careers list links each role at href="/careers/<slug>"; detail pages
// render an h1 plus icon badges (map-pin location, briefcase type,
// building2 department).
export const PULSESPACE_LIST_SELECTOR = 'a[href*="/careers/"]';
export const PULSESPACE_DETAIL_SELECTOR = 'main h1';

/**
 * Hosts this plugin may fetch or navigate to — mirrors `companyDomains`
 * (Spec 1689). A caller-supplied `companyUrl` elsewhere is ignored in favour
 * of {@link PULSESPACE_CAREERS_URL}; a bundle `<script src>` elsewhere is not
 * fetched.
 */
export const PULSESPACE_ALLOWED_HOSTS: readonly string[] = ['pulsespace.com'];

/**
 * How the plugin reads the board (Spec 1689). Both strategies stay in code so
 * either keeps working if the site changes again:
 *
 * - `bundle` — plain HTTP: the careers shell, then the main Vite bundle's
 *   `wve` job map (the pre-Spec-5134 path; two requests, no browser).
 * - `rendered` — a stealth Chromium renders the careers list and each
 *   `/careers/<slug>` detail page (Spec 5134, after the site rebuild).
 *   Default: it is what the fork shipped and what the live site needs — the
 *   rebuilt bundle no longer carries the `wve` map (Spec 5134 log), so
 *   `auto` paid for a careers + bundle fetch (up to 2 MB) that returned
 *   nothing on every scrape before launching the browser anyway.
 * - `auto` — `bundle` first; `rendered` when the bundle yields no jobs or
 *   fails. Opt-in, for when the bundle carries the map again or the image
 *   ships no browser and the bundle path is the only one that can work.
 */
export type PulsespaceStrategy = 'auto' | 'rendered' | 'bundle';

/** Env var selecting the {@link PulsespaceStrategy}. */
export const PULSESPACE_STRATEGY_ENV = 'PULSESPACE_STRATEGY';

/** Strategy used when {@link PULSESPACE_STRATEGY_ENV} is unset or unknown. */
export const PULSESPACE_DEFAULT_STRATEGY: PulsespaceStrategy = 'rendered';

/** Accepted spellings of each strategy (`dom`/`browser`/`http` are aliases). */
const PULSESPACE_STRATEGY_ALIASES: ReadonlyMap<string, PulsespaceStrategy> = new Map<
  string,
  PulsespaceStrategy
>([
  ['auto', 'auto'],
  ['rendered', 'rendered'],
  ['render', 'rendered'],
  ['dom', 'rendered'],
  ['browser', 'rendered'],
  ['bundle', 'bundle'],
  ['http', 'bundle'],
]);

/**
 * The strategy named by {@link PULSESPACE_STRATEGY_ENV}; `null` when the
 * variable is set to something unrecognised (the caller falls back to
 * {@link PULSESPACE_DEFAULT_STRATEGY} and says so), and the default when unset.
 */
export function readPulsespaceStrategy(
  env: NodeJS.ProcessEnv = process.env,
): PulsespaceStrategy | null {
  const raw = (env[PULSESPACE_STRATEGY_ENV] ?? '').trim().toLowerCase();
  if (!raw) return PULSESPACE_DEFAULT_STRATEGY;
  return PULSESPACE_STRATEGY_ALIASES.get(raw) ?? null;
}

/** Markers that open the bundle's job map, tried in order. */
export const PULSESPACE_BUNDLE_MARKERS = ['const wve=', 'var wve=', 'let wve=', 'wve='];

/**
 * Largest object literal the bundle strategy will slice out and parse (Spec
 * 1689). The bundle is third-party JS; a literal past this is treated as
 * malformed rather than parsed.
 */
export const PULSESPACE_MAX_BUNDLE_LITERAL_CHARS = 2_000_000;
