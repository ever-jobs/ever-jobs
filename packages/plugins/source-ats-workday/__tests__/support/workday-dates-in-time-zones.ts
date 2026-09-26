/**
 * Child-process driver for `workday.constants.spec.ts` (Spec 1736 T17).
 *
 * Jest hands each test file a copy of `process.env`, so a test cannot change
 * the host time zone: assigning `process.env.TZ` there never reaches Node.
 * This script runs in a plain Node process (ts-node), where it does. It reads
 * `{ zones, cases }` as JSON on stdin and writes, per zone, the UTC offset the
 * zone produced (the control that the switch happened) and, per case, the
 * board date `resolveWorkdayBoardToday` gives and the dates of the labels
 * counted back from it (from `now` when the board is undated).
 */
import { readFileSync } from 'fs';
import {
  parseWorkdayPostedOn,
  resolveWorkdayBoardToday,
  WorkdayBoardDateSample,
} from '../../src/workday.constants';

export interface TimeZoneCase {
  readonly now: string;
  readonly samples: WorkdayBoardDateSample[];
  readonly labels: string[];
}

export interface TimeZoneResult {
  readonly zone: string;
  /** `getTimezoneOffset()` on 2026-09-26T00:00:00Z in this zone. */
  readonly utcOffsetMinutes: number;
  readonly cases: Array<{ board: string | null; offsetDays: number | null; dates: Array<string | null> }>;
}

const input = JSON.parse(readFileSync(0, 'utf8')) as { zones: string[]; cases: TimeZoneCase[] };

const results: TimeZoneResult[] = input.zones.map((zone) => {
  process.env.TZ = zone;
  return {
    zone,
    utcOffsetMinutes: new Date('2026-09-26T00:00:00Z').getTimezoneOffset(),
    cases: input.cases.map((testCase) => {
      const now = new Date(testCase.now);
      const board = resolveWorkdayBoardToday(testCase.samples, now);
      return {
        board: board?.date ?? null,
        offsetDays: board?.offsetDays ?? null,
        dates: testCase.labels.map((label) => parseWorkdayPostedOn(label, board?.reference ?? now)),
      };
    }),
  };
});

process.stdout.write(JSON.stringify(results));
