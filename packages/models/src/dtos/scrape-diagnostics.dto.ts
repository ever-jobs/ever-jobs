/**
 * Per-source outcome diagnostics (Spec 5082).
 *
 * A source that returns zero jobs is otherwise indistinguishable from one that
 * failed. These types carry a categorized `reason` (and the real error message
 * in `detail`) from a plugin, through the fan-out, out to the HTTP response —
 * so a caller can tell "board is empty" apart from "browser never launched".
 */

export type ScrapeReason =
  | 'ok'
  | 'empty'
  | 'blocked'
  | 'browser_unavailable'
  | 'fetch_error'
  | 'timeout'
  | 'bad_input'
  /** The breaker was open, so the source was deliberately not called at all. */
  | 'circuit_open'
  | 'unknown';

/** Reason a single scrape produced the result it did. Optional on a response. */
export class ScrapeDiagnostics {
  reason: ScrapeReason;
  /** Real, human-readable detail (e.g. the underlying error message), truncated. */
  detail?: string;

  constructor(reason: ScrapeReason, detail?: string) {
    this.reason = reason;
    if (detail) this.detail = detail;
  }
}

/** One row per source in a fan-out: what it returned and why. */
export class SourceDiagnosticDto {
  site: string;
  count: number;
  reason: ScrapeReason;
  detail?: string;

  constructor(site: string, count: number, reason: ScrapeReason, detail?: string) {
    this.site = site;
    this.count = count;
    this.reason = reason;
    if (detail) this.detail = detail;
  }
}

/**
 * Reasons an operator can act on. `ok` and `empty` are the overwhelming majority
 * of a full fan-out (~1 800 sources) and say only "this worked" or "this board
 * had nothing" — carrying them on every response is noise measured in hundreds
 * of kilobytes.
 */
export const ACTIONABLE_SCRAPE_REASONS: readonly ScrapeReason[] = [
  'blocked',
  'browser_unavailable',
  'fetch_error',
  'timeout',
  'bad_input',
  'circuit_open',
  'unknown',
];

/** How much of the per-source breakdown a caller asked for. */
export type DiagnosticsMode = 'off' | 'actionable' | 'all';

/** Default cap on returned rows. Generous — the filter does the real work. */
export const DEFAULT_DIAGNOSTICS_LIMIT = 200;

/**
 * Counts that survive filtering and truncation, so a caller can always tell how
 * much it is NOT seeing.
 */
export class ScrapeDiagnosticsSummaryDto {
  /** Sources in the fan-out, before any filtering. */
  total: number;
  /** Rows matching {@link ACTIONABLE_SCRAPE_REASONS}. */
  actionable: number;
  /** Rows actually present in `per_source`. */
  returned: number;
  /** Rows dropped by the cap (not by the filter). */
  truncated: number;
  /** Count of every reason across the full fan-out, including filtered-out rows. */
  by_reason: Partial<Record<ScrapeReason, number>>;

  constructor(
    total: number,
    actionable: number,
    returned: number,
    truncated: number,
    by_reason: Partial<Record<ScrapeReason, number>>,
  ) {
    this.total = total;
    this.actionable = actionable;
    this.returned = returned;
    this.truncated = truncated;
    this.by_reason = by_reason;
  }
}

/**
 * Reduce a full per-source breakdown to what a caller asked for.
 *
 * `mode: 'off'` returns nothing but still counts everything, so the summary
 * remains a cheap, complete picture — a caller that wants totals need not pull
 * ~1 800 rows to get them.
 */
export function summarizeSourceDiagnostics(
  rows: SourceDiagnosticDto[],
  mode: DiagnosticsMode = 'off',
  limit: number = DEFAULT_DIAGNOSTICS_LIMIT,
): { rows: SourceDiagnosticDto[]; summary: ScrapeDiagnosticsSummaryDto } {
  const by_reason: Partial<Record<ScrapeReason, number>> = {};
  for (const row of rows) {
    by_reason[row.reason] = (by_reason[row.reason] ?? 0) + 1;
  }

  const actionableRows = rows.filter((r) => ACTIONABLE_SCRAPE_REASONS.includes(r.reason));

  if (mode === 'off') {
    return {
      rows: [],
      summary: new ScrapeDiagnosticsSummaryDto(rows.length, actionableRows.length, 0, 0, by_reason),
    };
  }

  const selected = mode === 'all' ? rows : actionableRows;
  // A non-positive or non-finite limit means "no cap" rather than "return nothing":
  // silently emptying the payload is the worse failure for a diagnostics channel.
  const capped = Number.isFinite(limit) && limit > 0 ? selected.slice(0, limit) : selected;

  return {
    rows: capped,
    summary: new ScrapeDiagnosticsSummaryDto(
      rows.length,
      actionableRows.length,
      capped.length,
      selected.length - capped.length,
      by_reason,
    ),
  };
}

const MAX_DETAIL = 300;

/**
 * Map an arbitrary thrown value to a `ScrapeDiagnostics`, preserving the real
 * message in `detail`. Pattern order matters: browser-launch failures are
 * checked before the generic network rules because Playwright launch errors can
 * mention both.
 */
function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return [err.message, typeof code === 'string' ? code : '']
      .filter(Boolean)
      .join(' ');
  }
  if (err && typeof err === 'object') {
    const o = err as { message?: unknown; name?: unknown; code?: unknown };
    return [o.message, o.name, o.code]
      .filter((v): v is string => typeof v === 'string')
      .join(' ');
  }
  return String(err ?? '');
}

export function classifyScrapeError(err: unknown): ScrapeDiagnostics {
  const message = messageOf(err);
  const detail = message.trim().slice(0, MAX_DETAIL) || undefined;
  const m = message.toLowerCase();

  if (
    /executable doesn'?t exist|launchpersistentcontext|playwright install|failed to launch|browsertype\.launch|browser has been closed|no usable sandbox|missing dependencies to run browsers/.test(
      m,
    )
  ) {
    return new ScrapeDiagnostics('browser_unavailable', detail);
  }
  if (/timeout|timed out|deadline exceeded|etimedout|esockettimedout/.test(m)) {
    return new ScrapeDiagnostics('timeout', detail);
  }
  if (
    /\b403\b|forbidden|cloudflare|just a moment|captcha|access denied|blocked|challenge/.test(
      m,
    )
  ) {
    return new ScrapeDiagnostics('blocked', detail);
  }
  if (
    /econnrefused|enotfound|eai_again|econnreset|socket hang up|getaddrinfo|network error|dns|\b5\d\d\b|\b429\b/.test(
      m,
    )
  ) {
    return new ScrapeDiagnostics('fetch_error', detail);
  }
  return new ScrapeDiagnostics('unknown', detail);
}

/**
 * Heuristic: does this HTML look like a bot-challenge / interstitial rather than
 * a real page? Used to label a zero-posting result `blocked` instead of `empty`.
 */
export function looksLikeChallenge(html: string): boolean {
  if (!html) return false;
  const s = html.toLowerCase();
  return /just a moment|cf-browser-verification|cf-challenge|challenge-platform|_cf_chl|attention required|enable javascript and cookies|verifying you are human|px-captcha|captcha-delivery/.test(
    s,
  );
}
