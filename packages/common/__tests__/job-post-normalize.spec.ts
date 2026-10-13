import { JobPostDto } from '@ever-jobs/models';
import { normalizeJobPost } from '@ever-jobs/common';

describe('normalizeJobPost (Spec 5162)', () => {
  const job = (over: Partial<JobPostDto>): JobPostDto =>
    new JobPostDto({ title: 'Engineer', jobUrl: 'https://x.test/j/1', ...over });

  it('trims edge whitespace', () => {
    expect(normalizeJobPost(job({ title: '  Welder  ' })).title).toBe('Welder');
  });

  it('trims zero-width chars and BOM', () => {
    expect(normalizeJobPost(job({ title: '​Acme Co‌‍﻿' })).title).toBe('Acme Co');
  });

  it('blank becomes null, not empty string', () => {
    const out = normalizeJobPost(job({ department: '   ' }));
    expect(out.department).toBeNull();
    expect(normalizeJobPost(job({ department: '​' })).department).toBeNull();
  });

  it('collapses interior runs in display names', () => {
    expect(normalizeJobPost(job({ title: 'Senior\n  Welder' })).title).toBe('Senior Welder');
    expect(normalizeJobPost(job({ companyName: '  Acme\t Co.  ' })).companyName).toBe('Acme Co.');
  });

  it('preserves interior characters in ids and urls', () => {
    const out = normalizeJobPost(job({
      id: '  abc 123  ',
      jobUrl: '  https://x.test/j/1  ',
      applyUrl: '  https://x.test/apply?a=b c  ',
    }));
    expect(out.id).toBe('abc 123');
    expect(out.jobUrl).toBe('https://x.test/j/1');
    expect(out.applyUrl).toBe('https://x.test/apply?a=b c');
  });

  it('trims description ends only', () => {
    const out = normalizeJobPost(job({ description: '  line one\n\n  line two  ' }));
    expect(out.description).toBe('line one\n\n  line two');
  });

  it('cleans + dedupes emails and skills', () => {
    const out = normalizeJobPost(job({
      emails: [' a@x.test ', '', 'a@x.test', '  b@x.test'],
      skills: [' welding ', 'welding', ' ', 'fitting'],
    }));
    expect(out.emails).toEqual(['a@x.test', 'b@x.test']);
    expect(out.skills).toEqual(['welding', 'fitting']);
  });

  it('cleans location/locations/offices string parts', () => {
    const out = normalizeJobPost(job({
      location: { city: ' Austin ', state: 'TX  ', streetAddress: ' 100\n  Main St ', country: ' US ', postalCode: ' 78701 ' },
      locations: [{ city: 'Denver ', name: ' Denver\tHQ ' }],
      offices: [{ name: ' Berlin Office ', id: ' off-1 ' }],
    } as Partial<JobPostDto>));
    expect(out.location).toMatchObject({ city: 'Austin', state: 'TX', streetAddress: '100 Main St', country: 'US', postalCode: '78701' });
    expect(out.locations![0]).toMatchObject({ city: 'Denver', name: 'Denver HQ' });
    expect(out.offices![0]).toMatchObject({ name: 'Berlin Office', id: 'off-1' });
  });

  it('cleans compensation currency/interval', () => {
    const out = normalizeJobPost(job({ compensation: { currency: ' USD ', interval: 'yearly' as never, minAmount: 1, maxAmount: 2 } }));
    expect(out.compensation).toMatchObject({ currency: 'USD', interval: 'yearly', minAmount: 1, maxAmount: 2 });
  });

  it('leaves site untouched', () => {
    const out = normalizeJobPost(job({ site: '  greenhouse ' }));
    expect(out.site).toBe('  greenhouse ');
  });

  it('does not mutate the input', () => {
    const input = job({ title: '  Welder ', emails: [' a@x.test '] });
    const snapshot = { ...input };
    normalizeJobPost(input);
    expect(input.title).toBe(snapshot.title);
    expect(input.emails).toEqual(snapshot.emails);
  });

  it('is idempotent', () => {
    const once = normalizeJobPost(job({ title: '  Senior\n Welder  ', department: ' Shop ' }));
    expect(normalizeJobPost(once)).toEqual(once);
  });

  it('passes non-object input through', () => {
    expect(normalizeJobPost(undefined as never)).toBeUndefined();
  });
});
