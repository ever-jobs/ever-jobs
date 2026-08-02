import {
  extractLdJsonBlocks,
  parseJobPostingLd,
  jobPostingLdFromNode,
  jobPostingLdToCompensation,
} from '../src';
import { CompensationInterval } from '@ever-jobs/models';

/** Wrap an ld+json payload in a script block (optionally several). */
function page(...payloads: unknown[]): string {
  const scripts = payloads
    .map(
      (p) =>
        `<script type="application/ld+json">${JSON.stringify(p)}</script>`,
    )
    .join('\n');
  return `<!doctype html><html><head>${scripts}</head><body>x</body></html>`;
}

const baseJob = {
  '@context': 'https://schema.org',
  '@type': 'JobPosting',
  title: 'Staff Engineer',
  description: '<p>Build things.</p>',
  datePosted: '2026-06-11T21:42:38-05:00',
  hiringOrganization: {
    '@type': 'Organization',
    name: 'Acme Corp',
    sameAs: 'https://acme.example',
  },
};

describe('extractLdJsonBlocks', () => {
  it('parses every ld+json block, skipping malformed ones', () => {
    const html = `
      <script type="application/ld+json">${JSON.stringify({ a: 1 })}</script>
      <script type="application/ld+json">{ not valid json }</script>
      <script type='application/ld+json'>${JSON.stringify({ b: 2 })}</script>`;
    const blocks = extractLdJsonBlocks(html);
    expect(blocks).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns [] for empty or block-free html', () => {
    expect(extractLdJsonBlocks('')).toEqual([]);
    expect(extractLdJsonBlocks('<html><body>no scripts</body></html>')).toEqual(
      [],
    );
  });
});

describe('parseJobPostingLd', () => {
  it('parses a single JobPosting object', () => {
    const [job] = parseJobPostingLd(page(baseJob));
    expect(job.title).toBe('Staff Engineer');
    expect(job.description).toBe('<p>Build things.</p>');
    expect(job.datePosted).toBe('2026-06-11T21:42:38-05:00');
    expect(job.hiringOrganizationName).toBe('Acme Corp');
    expect(job.hiringOrganizationUrl).toBe('https://acme.example');
  });

  it('ignores non-JobPosting blocks (e.g. WebSite)', () => {
    const jobs = parseJobPostingLd(page({ '@type': 'WebSite' }, baseJob));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Staff Engineer');
  });

  it('unwraps an array of postings in a single block', () => {
    const jobs = parseJobPostingLd(
      page([baseJob, { ...baseJob, title: 'Second Role' }]),
    );
    expect(jobs.map((j) => j.title)).toEqual(['Staff Engineer', 'Second Role']);
  });

  it('unwraps a @graph container', () => {
    const jobs = parseJobPostingLd(
      page({ '@context': 'https://schema.org', '@graph': [baseJob] }),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Staff Engineer');
  });

  it('unwraps an ItemList of ListItem.item postings', () => {
    const jobs = parseJobPostingLd(
      page({
        '@type': 'ItemList',
        itemListElement: [
          { '@type': 'ListItem', item: baseJob },
          { '@type': 'ListItem', item: { ...baseJob, title: 'Listed Role' } },
        ],
      }),
    );
    expect(jobs.map((j) => j.title)).toEqual(['Staff Engineer', 'Listed Role']);
  });

  it('accepts @type given as an array', () => {
    const jobs = parseJobPostingLd(
      page({ ...baseJob, '@type': ['JobPosting', 'Thing'] }),
    );
    expect(jobs).toHaveLength(1);
  });

  it('falls back to name when title is absent', () => {
    const [job] = parseJobPostingLd(
      page({ '@type': 'JobPosting', name: 'Named Role' }),
    );
    expect(job.title).toBe('Named Role');
  });

  it('returns [] when there is no JobPosting', () => {
    expect(parseJobPostingLd(page({ '@type': 'WebSite' }))).toEqual([]);
    expect(parseJobPostingLd('<html></html>')).toEqual([]);
  });

  it('joins an array employmentType and detects remote', () => {
    const [job] = parseJobPostingLd(
      page({
        ...baseJob,
        employmentType: ['FULL_TIME', 'CONTRACTOR'],
        jobLocationType: 'TELECOMMUTE',
      }),
    );
    expect(job.employmentType).toBe('FULL_TIME, CONTRACTOR');
    expect(job.remote).toBe(true);
  });

  it('parses multiple structured locations', () => {
    const [job] = parseJobPostingLd(
      page({
        ...baseJob,
        jobLocation: [
          {
            '@type': 'Place',
            address: {
              '@type': 'PostalAddress',
              addressLocality: 'Austin',
              addressRegion: 'TX',
              addressCountry: 'US',
              postalCode: '78701',
            },
          },
          {
            '@type': 'Place',
            address: {
              addressLocality: 'Berlin',
              addressCountry: { '@type': 'Country', name: 'Germany' },
            },
          },
        ],
      }),
    );
    expect(job.locations).toHaveLength(2);
    expect(job.locations[0]).toMatchObject({
      city: 'Austin',
      region: 'TX',
      country: 'US',
      postalCode: '78701',
      label: 'Austin, TX, US',
    });
    expect(job.locations[1]).toMatchObject({ city: 'Berlin', country: 'Germany' });
  });

  it('parses a min/max baseSalary into a normalised range', () => {
    const [job] = parseJobPostingLd(
      page({
        ...baseJob,
        baseSalary: {
          '@type': 'MonetaryAmount',
          currency: 'USD',
          value: {
            '@type': 'QuantitativeValue',
            minValue: 120000,
            maxValue: 160000,
            unitText: 'YEAR',
          },
        },
      }),
    );
    expect(job.baseSalary).toEqual({
      minAmount: 120000,
      maxAmount: 160000,
      currency: 'USD',
      interval: CompensationInterval.YEARLY,
    });
  });

  it('parses a single-value baseSalary as min=max', () => {
    const [job] = parseJobPostingLd(
      page({
        ...baseJob,
        baseSalary: {
          currency: 'USD',
          value: { value: 50, unitText: 'HOUR' },
        },
      }),
    );
    expect(job.baseSalary).toEqual({
      minAmount: 50,
      maxAmount: 50,
      currency: 'USD',
      interval: CompensationInterval.HOURLY,
    });
  });

  it('extracts an apply URL from potentialAction (ApplyAction)', () => {
    const [job] = parseJobPostingLd(
      page({
        ...baseJob,
        url: 'https://acme.example/jobs/1',
        potentialAction: {
          '@type': 'ApplyAction',
          target: { '@type': 'EntryPoint', url: 'https://apply.example/1' },
        },
      }),
    );
    expect(job.url).toBe('https://acme.example/jobs/1');
    expect(job.applyUrl).toBe('https://apply.example/1');
  });
});

describe('jobPostingLdToCompensation', () => {
  it('maps a salary range to a CompensationDto', () => {
    const comp = jobPostingLdToCompensation({
      minAmount: 100,
      maxAmount: 200,
      currency: 'EUR',
      interval: CompensationInterval.MONTHLY,
    });
    expect(comp).toMatchObject({
      minAmount: 100,
      maxAmount: 200,
      currency: 'EUR',
      interval: CompensationInterval.MONTHLY,
    });
  });

  it('returns null when there is no amount', () => {
    expect(jobPostingLdToCompensation(null)).toBeNull();
    expect(
      jobPostingLdToCompensation({
        minAmount: null,
        maxAmount: null,
        currency: 'USD',
        interval: null,
      }),
    ).toBeNull();
  });
});

describe('jobPostingLdFromNode', () => {
  it('maps a pre-parsed JobPosting object (e.g. Paycom googleJobJson)', () => {
    const node = jobPostingLdFromNode({
      ...baseJob,
      url: 'https://example.com/jobs/42',
      baseSalary: {
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: { '@type': 'QuantitativeValue', minValue: 90000, maxValue: 120000, unitText: 'YEAR' },
      },
    });
    expect(node?.title).toBe('Staff Engineer');
    expect(node?.datePosted).toBe('2026-06-11T21:42:38-05:00');
    expect(node?.url).toBe('https://example.com/jobs/42');
    expect(jobPostingLdToCompensation(node?.baseSalary)).toMatchObject({
      minAmount: 90000,
      maxAmount: 120000,
      currency: 'USD',
      interval: CompensationInterval.YEARLY,
    });
  });

  it('parses a JSON string and unwraps @graph containers', () => {
    const fromString = jobPostingLdFromNode(JSON.stringify(baseJob));
    expect(fromString?.title).toBe('Staff Engineer');

    const fromGraph = jobPostingLdFromNode({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'WebSite' }, baseJob],
    });
    expect(fromGraph?.title).toBe('Staff Engineer');
  });

  it('returns null for empty / malformed / non-JobPosting input', () => {
    expect(jobPostingLdFromNode(null)).toBeNull();
    expect(jobPostingLdFromNode('')).toBeNull();
    expect(jobPostingLdFromNode('{ not json')).toBeNull();
    expect(jobPostingLdFromNode({ '@type': 'Organization', name: 'Acme' })).toBeNull();
  });
});
