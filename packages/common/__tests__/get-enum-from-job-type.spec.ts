/**
 * Spec 1697 — `getEnumFromJobType` passes its lookup options through to
 * `getJobTypeFromString`. Without options the lookup is unchanged.
 */
import { getEnumFromJobType } from '@ever-jobs/common';
import { JobType, getJobTypeFromString } from '@ever-jobs/models';

describe('getEnumFromJobType (Spec 1697 options pass-through)', () => {
  it('resolves a whole label exactly like getJobTypeFromString without options', () => {
    for (const label of ['Full-time', 'CDI', 'Alternance', 'permanent', 'nope']) {
      expect(getEnumFromJobType(label)).toBe(getJobTypeFromString(label));
    }
    expect(getEnumFromJobType('CDI')).toBe(JobType.PERMANENT);
  });

  it('enables a locale-scoped alias only when the locale is passed', () => {
    expect(getEnumFromJobType('stage')).toBeNull();
    expect(getEnumFromJobType('stage', { locale: 'fr-FR' })).toBe(JobType.INTERNSHIP);
    expect(getEnumFromJobType('stage', { locale: 'de' })).toBeNull();
  });

  it("ignores prose-ambiguous aliases in 'token' mode and keeps them in 'label' mode", () => {
    expect(getEnumFromJobType('permanent', { mode: 'label' })).toBe(JobType.PERMANENT);
    expect(getEnumFromJobType('permanent', { mode: 'token' })).toBeNull();
  });
});
