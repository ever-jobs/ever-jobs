import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatePostedBasis, DatePostedPrecision, JobType } from '@ever-jobs/models';

/**
 * The published tool manifest must advertise what the API accepts: every job
 * type (Spec 1697 added `permanent` and `apprenticeship`) and the Spec 1700
 * search inputs.
 */
type SchemaNode = { type?: string; format?: string; enum?: string[]; properties?: Record<string, SchemaNode>; items?: SchemaNode };

const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'tool_manifest.json'), 'utf8')) as {
  input_schema: { properties: Record<string, { enum?: string[] }> };
  output_schema: { properties: { jobs: { items: { properties: Record<string, SchemaNode> } } } };
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

  it('advertises the Spec 1696 posted-time output fields with every enum value, in enum order', () => {
    const job = manifest.output_schema.properties.jobs.items.properties;
    expect(job.datePostedAt).toMatchObject({ type: 'string', format: 'date-time' });
    expect(job.datePostedPrecision.enum).toEqual(Object.values(DatePostedPrecision));
    expect(job.datePostedBasis.enum).toEqual(Object.values(DatePostedBasis));
  });
});
