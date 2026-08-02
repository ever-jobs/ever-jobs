import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ScraperInputDto, Site } from '@ever-jobs/models';
import { CanekastService } from '../src/canekast.service';

const FIXTURES = join(__dirname, 'fixtures');
const LISTING_HTML = readFileSync(join(FIXTURES, 'careers.html'), 'utf8');

const PDF_TEXT_BY_SLUG: Record<string, string> = {
  'engineering-leader-castings': readFileSync(
    join(FIXTURES, 'engineering-leader-castings.txt'),
    'utf8',
  ),
  'foundry-operator': readFileSync(
    join(FIXTURES, 'foundry-operator.txt'),
    'utf8',
  ),
  'melt-supervisor': readFileSync(
    join(FIXTURES, 'melt-supervisor.txt'),
    'utf8',
  ),
};

/** Access the protected fetch seams without loosening them to `any`. */
interface Seams {
  fetchListingHtml: (client: unknown) => Promise<string>;
  fetchPdfText: (client: unknown, url: string) => Promise<string>;
}

function slugOf(url: string): string {
  return (
    url
      .split(/[?#]/)[0]
      .split('/')
      .pop()
      ?.replace(/\.pdf$/i, '')
      .toLowerCase() ?? ''
  );
}

function serviceWith(
  html: string = LISTING_HTML,
  pdfText: (url: string) => string = (url) => PDF_TEXT_BY_SLUG[slugOf(url)] ?? '',
): CanekastService {
  const service = new CanekastService();
  const seams = service as unknown as Seams;
  jest.spyOn(seams, 'fetchListingHtml').mockResolvedValue(html);
  jest
    .spyOn(seams, 'fetchPdfText')
    .mockImplementation(async (_client, url) => pdfText(url));
  return service;
}

function inputFrom(overrides: Partial<ScraperInputDto> = {}): ScraperInputDto {
  return Object.assign(new ScraperInputDto(), overrides);
}

describe('CanekastService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses the three roles, de-duped by PDF and free of the .pdf decoy', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.title).sort()).toEqual([
      'Engineering Leader, Castings',
      'Foundry Operator',
      'Melt Supervisor',
    ]);
    // the non-/uploads brochure PDF is not a role
    expect(jobs.some((j) => /brochure/i.test(j.jobUrl ?? ''))).toBe(false);
  });

  it('maps identity, jobUrl, shared apply form, and null date per role', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const foundry = jobs.find((j) => j.title === 'Foundry Operator')!;
    expect(foundry.site).toBe(Site.CANEKAST);
    expect(foundry.id).toBe('canekast-foundry-operator');
    expect(foundry.companyName).toBe('CaneKast');
    expect(foundry.jobUrl).toBe(
      'https://canekast.com/wp-content/uploads/2021/05/Foundry-Operator.pdf',
    );
    expect(foundry.applyUrl).toBe('https://canekast.com/careers/');
    expect(foundry.emails).toEqual([]);
    expect(foundry.isRemote).toBe(false);
    expect(foundry.datePosted).toBeNull();
    expect(foundry.compensation ?? null).toBeNull();
  });

  it('derives location from the PDF letterhead (Chaska, MN)', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    for (const job of jobs) {
      expect(job.location?.displayLocation()).toContain('Chaska');
      expect(job.location?.state).toBe('MN');
    }
  });

  it('carries the PDF body into the description with the letterhead stripped', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const foundry = jobs.find((j) => j.title === 'Foundry Operator')!;
    expect(foundry.description).toContain('Foundry Operator');
    expect(foundry.description).toContain('Qualifications');
    // the mailing-address letterhead must not leak into the description
    expect(foundry.description).not.toContain('840 Arbor Drive');
    expect(foundry.description).not.toContain('Phone 952-448-2801');
  });

  it('degrades gracefully when a PDF cannot be fetched (keeps listing fields)', async () => {
    const service = serviceWith(LISTING_HTML, (url) =>
      /Melt-Supervisor/i.test(url) ? '' : PDF_TEXT_BY_SLUG[slugOf(url)] ?? '',
    );
    const { jobs } = await service.scrape(inputFrom());
    const melt = jobs.find((j) => j.title === 'Melt Supervisor')!;
    expect(melt).toBeDefined();
    expect(melt.description).toBeNull();
    expect(melt.location ?? null).toBeNull();
    expect(melt.jobUrl).toContain('Melt-Supervisor.pdf');
  });

  it('applies searchTerm and resultsWanted filters', async () => {
    const filtered = await serviceWith().scrape(
      inputFrom({ searchTerm: 'Melt Supervisor' }),
    );
    expect(filtered.jobs).toHaveLength(1);
    expect(filtered.jobs[0].title).toBe('Melt Supervisor');

    const capped = await serviceWith().scrape(inputFrom({ resultsWanted: 2 }));
    expect(capped.jobs).toHaveLength(2);
  });

  it('returns empty (no throw) when the listing has no openings', async () => {
    const { jobs } = await serviceWith('<html><body></body></html>').scrape(
      inputFrom(),
    );
    expect(jobs).toHaveLength(0);
  });
});
