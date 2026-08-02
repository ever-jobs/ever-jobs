import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ScraperInputDto, Site } from '@ever-jobs/models';

const mockGet = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, setHeaders: jest.fn() })),
  };
});

import {
  TerraformIndustriesModule,
  TerraformIndustriesService,
} from '../src';

const HOME_HTML = `
<html><body>
  <tt><a href="https://docs.google.com/document/d/BEFORE1/">Ignored Before Careers</a></tt>
  <br>
  <tt><b>Careers</b></tt>
  <br>
  <tt><a href="https://docs.google.com/document/d/DOC1/">Technical Chief of Staff</a></tt>
  <br>
  <tt><a href="https://docs.google.com/document/d/DOC2/">Electrolyzer Product Technician</a></tt>
  <br>
  <tt><a href="https://docs.google.com/document/d/DOC2/">Direct Air Capture Technician</a></tt>
  <br>
  <tt><a href="https://example.com/blog">Not a job link</a></tt>
</body></html>`;

const DOC1_TXT = [
  'Terraform Industries, Inc.',
  'Technical Chief of Staff',
  'terraformindustries.com',
  'Los Angeles, California',
  '',
  '',
  'Do you work with nuts and bolts, but think in systems?',
  '',
  '',
  'Responsibilities',
  '* Formulate and execute technical analysis.',
  '',
  'Pay range: $120,000.00 - $180,000.00 per year, to be determined on a case-by-case basis.',
].join('\n');

const DOC2_TXT = [
  'Terraform Industries, Inc.',
  'Mechanical Technician',
  'terraformindustries.com',
  'Remote',
  '',
  'Are you compelled to bring life to mechanical systems?',
  '',
  'Pay range: $120,000.00 - $150,000.00 per year.',
].join('\n');

function serve(overrides: Record<string, unknown> = {}): void {
  mockGet.mockImplementation((url: string) => {
    if (url.includes('/document/d/')) {
      const id = /\/document\/d\/([^/]+)\//.exec(url)?.[1] ?? '';
      if (id in overrides) {
        const value = overrides[id];
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve({ data: value });
      }
      if (id === 'DOC1') return Promise.resolve({ data: DOC1_TXT });
      if (id === 'DOC2') return Promise.resolve({ data: DOC2_TXT });
      return Promise.reject(new Error(`unexpected doc ${id}`));
    }
    return Promise.resolve({ data: overrides.home ?? HOME_HTML });
  });
}

const input = (over: Partial<ScraperInputDto> = {}): ScraperInputDto =>
  ({ resultsWanted: 9999, ...over }) as ScraperInputDto;

describe('TerraformIndustriesService', () => {
  beforeEach(() => mockGet.mockReset());

  it('resolves through its module and exposes the site value', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerraformIndustriesModule],
    }).compile();

    expect(moduleRef.get(TerraformIndustriesService)).toBeInstanceOf(
      TerraformIndustriesService,
    );
    expect(Site.TERRAFORMINDUSTRIES).toBe('terraformindustries');
    await moduleRef.close();
  });

  it('enumerates careers-section roles and enriches them from the Google Doc', async () => {
    serve();
    const jobs = (await new TerraformIndustriesService().scrape(input())).jobs;

    expect(jobs).toHaveLength(3);
    const chief = jobs.find((job) => job.title === 'Technical Chief of Staff');
    expect(chief).toMatchObject({
      id: 'terraformindustries-technical-chief-of-staff',
      site: Site.TERRAFORMINDUSTRIES,
      companyName: 'Terraform Industries',
      companyUrl: 'https://terraformindustries.com/',
      jobUrl: 'https://docs.google.com/document/d/DOC1/',
      isRemote: false,
    });
    expect(chief?.location).toMatchObject({
      city: 'Los Angeles',
      state: 'CA',
    });
    expect(chief?.description).toContain('Responsibilities');
    expect(chief?.description).not.toContain('terraformindustries.com');
    expect(chief?.compensation).toMatchObject({
      currency: 'USD',
      interval: 'yearly',
      minAmount: 120000,
      maxAmount: 180000,
    });
  });

  it('leaves compensation unset when the doc has no pay range', async () => {
    serve({
      DOC1: [
        'Terraform Industries, Inc.',
        'Technical Chief of Staff',
        'terraformindustries.com',
        'Los Angeles, California',
        '',
        'No salary stated here.',
      ].join('\n'),
    });
    const jobs = (await new TerraformIndustriesService().scrape(input())).jobs;
    const chief = jobs.find((job) => job.title === 'Technical Chief of Staff');
    expect(chief).not.toHaveProperty('compensation');
  });

  it('ignores doc links before the Careers heading and non-doc links', async () => {
    serve();
    const jobs = (await new TerraformIndustriesService().scrape(input())).jobs;

    expect(jobs.map((job) => job.title)).not.toContain('Ignored Before Careers');
    expect(jobs.map((job) => job.title)).not.toContain('Not a job link');
  });

  it('fetches a shared job doc only once and reuses it across roles', async () => {
    serve();
    await new TerraformIndustriesService().scrape(input());

    // 1 home page + DOC1 + DOC2 (shared by two technician roles) = 3 requests.
    expect(mockGet).toHaveBeenCalledTimes(3);
    const docCalls = mockGet.mock.calls.filter((call) =>
      String(call[0]).includes('/document/d/DOC2/'),
    );
    expect(docCalls).toHaveLength(1);
  });

  it('derives isRemote from a Remote doc location', async () => {
    serve();
    const jobs = (await new TerraformIndustriesService().scrape(input())).jobs;

    const tech = jobs.find(
      (job) => job.title === 'Direct Air Capture Technician',
    );
    expect(tech?.isRemote).toBe(true);
    expect(tech?.location).toMatchObject({ city: 'Remote' });
  });

  it('still returns a role when its doc fetch fails, with null enrichment', async () => {
    serve({ DOC1: new Error('boom') });
    const jobs = (await new TerraformIndustriesService().scrape(input())).jobs;

    const chief = jobs.find((job) => job.title === 'Technical Chief of Staff');
    expect(chief).toBeDefined();
    expect(chief?.location).toBeNull();
    expect(chief?.description).toBeNull();
    expect(chief?.isRemote).toBeNull();
    expect(chief).not.toHaveProperty('compensation');
  });

  it('returns an empty list when there is no recognizable Careers list', async () => {
    serve({ home: '<html><body><p>No openings.</p></body></html>' });
    const jobs = (await new TerraformIndustriesService().scrape(input())).jobs;
    expect(jobs).toEqual([]);
  });

  it('filters by search term against the title', async () => {
    serve();
    const jobs = (
      await new TerraformIndustriesService().scrape(input({ searchTerm: 'chief' }))
    ).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Technical Chief of Staff');
  });

  it('honors offset and resultsWanted', async () => {
    serve();
    const first = (
      await new TerraformIndustriesService().scrape(input({ resultsWanted: 1 }))
    ).jobs;
    expect(first).toHaveLength(1);
    expect(first[0].title).toBe('Technical Chief of Staff');

    const skipped = (
      await new TerraformIndustriesService().scrape(
        input({ offset: 1, resultsWanted: 5 }),
      )
    ).jobs;
    expect(skipped).toHaveLength(2);
    expect(skipped.map((job) => job.title)).not.toContain(
      'Technical Chief of Staff',
    );
  });

  it('returns an empty list when the home page request fails', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    const jobs = (await new TerraformIndustriesService().scrape(input())).jobs;
    expect(jobs).toEqual([]);
  });
});
