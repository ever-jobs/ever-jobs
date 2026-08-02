import { toDateOnly } from '../src/converters/date-converter';

describe('toDateOnly — Spec 5024', () => {
  it('preserves the source local day for an evening negative-offset timestamp', () => {
    // Would become 2026-04-21 under new Date(x).toISOString() UTC truncation.
    expect(toDateOnly('2026-04-20T22:32:33-04:00')).toBe('2026-04-20');
  });

  it('preserves the source local day for a positive-offset morning timestamp', () => {
    // 2026-04-20T01:00+09:00 is 2026-04-19T16:00Z; the local day is the 20th.
    expect(toDateOnly('2026-04-20T01:00:00+09:00')).toBe('2026-04-20');
  });

  it('passes through a bare date string', () => {
    expect(toDateOnly('2026-04-20')).toBe('2026-04-20');
  });

  it('keeps a Z (UTC) timestamp on its UTC day', () => {
    expect(toDateOnly('2026-04-20T22:32:33Z')).toBe('2026-04-20');
  });

  it('falls back to UTC truncation for epoch and Date inputs', () => {
    const epoch = Date.UTC(2026, 3, 20, 12, 0, 0);
    expect(toDateOnly(epoch)).toBe('2026-04-20');
    expect(toDateOnly(new Date(epoch))).toBe('2026-04-20');
  });

  it('returns null for empty or invalid input', () => {
    expect(toDateOnly(null)).toBeNull();
    expect(toDateOnly(undefined)).toBeNull();
    expect(toDateOnly('')).toBeNull();
    expect(toDateOnly('not-a-date')).toBeNull();
  });
});
