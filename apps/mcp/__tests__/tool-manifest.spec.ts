import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JobType } from '@ever-jobs/models';

/**
 * The published tool manifest must advertise what the API accepts: every job
 * type (Spec 1697 added `permanent` and `apprenticeship`) and the Spec 1700
 * search inputs.
 */
const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'tool_manifest.json'), 'utf8')) as {
  input_schema: { properties: Record<string, { enum?: string[] }> };
};

describe('tool_manifest.json', () => {
  it('lists every JobType value for jobType, in enum order', () => {
    expect(manifest.input_schema.properties.jobType.enum).toEqual(Object.values(JobType));
  });

  it('advertises the multi-location and exclusion inputs', () => {
    for (const key of ['locations', 'excludeTitleTerms', 'excludeKeywords', 'excludePresets']) {
      expect(manifest.input_schema.properties).toHaveProperty(key);
    }
  });
});
