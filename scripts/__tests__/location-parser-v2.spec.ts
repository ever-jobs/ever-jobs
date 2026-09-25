/**
 * Unit tests for `scripts/proto/location-parser-v2.ts` — the Spec 1689 ReDoS
 * hardening of the prototype parser (it shared the production parser's
 * exponential 'Remote … in …' regex).
 */

import {
  parseLocationListV2,
  parseLocationTextV2,
} from '../proto/location-parser-v2';

/** Best of three wall-clock runs, in milliseconds. */
function bestOf3Ms(fn: () => unknown): number {
  const once = (): number => {
    const start = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  return Math.min(once(), once(), once());
}

describe('location-parser-v2 ReDoS hardening (Spec 1689)', () => {
  const BUDGET_MS = 50;

  const remoteHeavy = (length: number, head: string): string => {
    const words = ['Nationwide', 'Opportunities', 'Available', 'Immediately'];
    let label = head;
    for (let i = 0; label.length < length; i++) label += ` ${words[i % words.length]}`;
    return label.slice(0, length);
  };

  beforeAll(() => {
    for (let i = 0; i < 20; i++) parseLocationListV2(['Remote in Germany', 'Austin, TX']);
  });

  it.each([
    ['60-char Remote label', remoteHeavy(60, 'Remote')],
    ['500-char Hybrid label', remoteHeavy(500, 'Hybrid')],
    ['20k-char serial-marker run', `Austin${'(1)'.repeat(7_000)}x`],
    ['20k-char connector run', `Austin${' & '.repeat(7_000)}TX`],
  ])('parses a %s within budget', (_name, label) => {
    expect(bestOf3Ms(() => parseLocationListV2([label]))).toBeLessThan(BUDGET_MS);
  });

  it('still reads "Remote in <country>"', () => {
    expect(parseLocationTextV2('Remote in Germany').location).toMatchObject({
      country: 'Germany',
    });
    expect(parseLocationTextV2('Hybrid full time in France').location).toMatchObject({
      country: 'France',
    });
  });
});
