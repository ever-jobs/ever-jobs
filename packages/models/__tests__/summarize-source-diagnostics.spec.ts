import 'reflect-metadata';
import {
  SourceDiagnosticDto,
  summarizeSourceDiagnostics,
  ACTIONABLE_SCRAPE_REASONS,
  DEFAULT_DIAGNOSTICS_LIMIT,
  type ScrapeReason,
} from '../src/dtos/scrape-diagnostics.dto';

/**
 * A full fan-out covers ~1 800 sources, so returning one row each put hundreds
 * of kilobytes of mostly-`ok`/`empty` noise on every search response. These
 * cover the filter, the cap and the opt-in that replaced that.
 */
describe('summarizeSourceDiagnostics', () => {
  const row = (site: string, reason: ScrapeReason, count = 0): SourceDiagnosticDto =>
    new SourceDiagnosticDto(site, count, reason, `detail for ${site}`);

  /** A realistic fan-out: overwhelmingly ok/empty, a handful worth acting on. */
  function fanOut(): SourceDiagnosticDto[] {
    const rows: SourceDiagnosticDto[] = [];
    for (let i = 0; i < 900; i++) rows.push(row(`ok-${i}`, 'ok', 3));
    for (let i = 0; i < 880; i++) rows.push(row(`empty-${i}`, 'empty'));
    rows.push(row('blocked-1', 'blocked'));
    rows.push(row('browser-1', 'browser_unavailable'));
    rows.push(row('fetch-1', 'fetch_error'));
    rows.push(row('timeout-1', 'timeout'));
    rows.push(row('breaker-1', 'circuit_open'));
    return rows;
  }

  describe('mode: off (the default)', () => {
    it('returns no rows at all', () => {
      const { rows } = summarizeSourceDiagnostics(fanOut());

      expect(rows).toHaveLength(0);
    });

    it('still reports complete counts, so totals need no second request', () => {
      const { summary } = summarizeSourceDiagnostics(fanOut());

      expect(summary.total).toBe(1785);
      expect(summary.actionable).toBe(5);
      expect(summary.returned).toBe(0);
      expect(summary.by_reason.ok).toBe(900);
      expect(summary.by_reason.empty).toBe(880);
      expect(summary.by_reason.circuit_open).toBe(1);
    });
  });

  describe('mode: actionable', () => {
    it('drops ok and empty and keeps everything an operator can act on', () => {
      const { rows } = summarizeSourceDiagnostics(fanOut(), 'actionable');

      expect(rows).toHaveLength(5);
      expect(rows.map((r) => r.reason).sort()).toEqual(
        ['blocked', 'browser_unavailable', 'circuit_open', 'fetch_error', 'timeout'].sort(),
      );
      expect(rows.some((r) => r.reason === 'ok')).toBe(false);
      expect(rows.some((r) => r.reason === 'empty')).toBe(false);
    });

    it('cuts the payload by well over 95% on a realistic fan-out', () => {
      const all = fanOut();
      const { rows } = summarizeSourceDiagnostics(all, 'actionable');

      const before = JSON.stringify(all).length;
      const after = JSON.stringify(rows).length;
      expect(after / before).toBeLessThan(0.05);
    });

    it('keeps the full picture in the summary even though rows were filtered', () => {
      const { summary } = summarizeSourceDiagnostics(fanOut(), 'actionable');

      expect(summary.total).toBe(1785);
      expect(summary.returned).toBe(5);
      expect(summary.truncated).toBe(0);
      expect(summary.by_reason.ok).toBe(900);
    });

    it('treats every ACTIONABLE_SCRAPE_REASONS member as actionable', () => {
      const rows = ACTIONABLE_SCRAPE_REASONS.map((r) => row(`s-${r}`, r));

      const { rows: kept } = summarizeSourceDiagnostics(rows, 'actionable');

      expect(kept).toHaveLength(ACTIONABLE_SCRAPE_REASONS.length);
    });
  });

  describe('mode: all', () => {
    it('returns every row up to the cap', () => {
      const { rows, summary } = summarizeSourceDiagnostics(fanOut(), 'all', 10_000);

      expect(rows).toHaveLength(1785);
      expect(summary.returned).toBe(1785);
      expect(summary.truncated).toBe(0);
    });
  });

  describe('the cap', () => {
    it('truncates and reports how many rows were dropped', () => {
      const { rows, summary } = summarizeSourceDiagnostics(fanOut(), 'all', 50);

      expect(rows).toHaveLength(50);
      expect(summary.returned).toBe(50);
      expect(summary.truncated).toBe(1735);
      expect(summary.total).toBe(1785);
    });

    it('defaults to DEFAULT_DIAGNOSTICS_LIMIT', () => {
      const { rows } = summarizeSourceDiagnostics(fanOut(), 'all');

      expect(rows).toHaveLength(DEFAULT_DIAGNOSTICS_LIMIT);
    });

    it('does not truncate when the selection already fits', () => {
      const { summary } = summarizeSourceDiagnostics(fanOut(), 'actionable', 200);

      expect(summary.truncated).toBe(0);
    });

    /** Emptying a diagnostics payload is the worse failure — treat it as "no cap". */
    it.each([0, -1, Number.NaN])('treats a limit of %p as no cap', (limit) => {
      const { rows } = summarizeSourceDiagnostics(fanOut(), 'actionable', limit as number);

      expect(rows).toHaveLength(5);
    });
  });

  it('handles an empty fan-out without throwing', () => {
    const { rows, summary } = summarizeSourceDiagnostics([], 'all');

    expect(rows).toEqual([]);
    expect(summary.total).toBe(0);
    expect(summary.actionable).toBe(0);
    expect(summary.by_reason).toEqual({});
  });

  it('does not mutate the caller’s array', () => {
    const all = fanOut();
    const before = all.length;

    summarizeSourceDiagnostics(all, 'actionable', 2);

    expect(all).toHaveLength(before);
  });
});
