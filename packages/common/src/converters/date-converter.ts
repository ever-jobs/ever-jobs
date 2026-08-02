/**
 * Normalize a posting timestamp to a `YYYY-MM-DD` calendar date.
 *
 * The widespread pattern `new Date(value).toISOString().split('T')[0]` first
 * shifts the instant to **UTC** and only then truncates, so any timestamp that
 * carries an explicit offset and falls in the evening (e.g. Greenhouse's
 * `2026-04-20T22:32:33-04:00`) rolls forward to the next UTC day
 * (`2026-04-21`) — losing the source's own calendar day.
 *
 * This keeps the date as written in the timestamp's own offset: for an ISO-8601
 * string the leading `YYYY-MM-DD` already is that local day, so we preserve it
 * verbatim. Non-ISO inputs (epoch numbers, `Date`, other formats) fall back to
 * the historical UTC-truncation behaviour.
 */
export function toDateOnly(
  value: string | number | Date | null | undefined,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/);
    if (match) return match[1];
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().split('T')[0];
}
