import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CompensationInterval, ScraperInputDto, Site } from '@ever-jobs/models';
import { DesktopmetalService } from '../src/desktopmetal.service';

const FIXTURES = join(__dirname, 'fixtures');
const LISTING_HTML = readFileSync(join(FIXTURES, 'careers.html'), 'utf8');

const PDF_TEXT_BY_SLUG: Record<string, string> = {
  'mechanical-engineer-i-product-development': readFileSync(
    join(FIXTURES, 'mechanical-engineer-i-product-development.txt'),
    'utf8',
  ),
  'arc-it-systems-engineer-job-description': readFileSync(
    join(FIXTURES, 'arc-it-systems-engineer-job-description.txt'),
    'utf8',
  ),
  'materials-logistics-specialist-1': readFileSync(
    join(FIXTURES, 'materials-logistics-specialist-1.txt'),
    'utf8',
  ),
};

/** Access the protected fetch seams without loosening them to `any`. */
interface Seams {
  fetchListingHtml: (input: ScraperInputDto) => Promise<string>;
  fetchPdfText: (client: unknown, url: string) => Promise<string>;
}

function serviceWith(
  html: string = LISTING_HTML,
  pdfText: (url: string) => string = (url) => {
    const slug =
      url
        .split(/[?#]/)[0]
        .split('/')
        .pop()
        ?.replace(/\.pdf$/i, '')
        .toLowerCase() ?? '';
    return PDF_TEXT_BY_SLUG[slug] ?? '';
  },
): DesktopmetalService {
  const service = new DesktopmetalService();
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

describe('DesktopmetalService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('parses the three openings with department, location, and global apply email', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    expect(jobs).toHaveLength(3);

    const mech = jobs.find((j) => j.title === 'Mechanical Engineer I')!;
    expect(mech).toBeDefined();
    expect(mech.site).toBe(Site.DESKTOPMETAL);
    expect(mech.id).toBe('desktopmetal-mechanical-engineer-i-product-development');
    expect(mech.companyName).toBe('Desktop Metal');
    expect(mech.department).toBe('Engineering');
    expect(mech.jobUrl).toBe(
      'https://www.desktopmetal.com/uploads/Mechanical-Engineer-I-Product-Development.pdf',
    );
    expect(mech.location?.displayLocation()).toContain('Burlington');
    expect(mech.isRemote).toBe(false);
    expect(mech.emails).toEqual(['jobs@desktopmetal.com']);
    // the address lives in `emails`; `applyUrl` is left unset (mailto: is not a URL)
    expect(mech.applyUrl == null).toBe(true);
    expect(mech.datePosted).toBeNull();

    const it = jobs.find((j) => j.title === 'Sr. IT Systems Engineer')!;
    expect(it.department).toBe('Information Technology');
    expect(it.location?.displayLocation()).toContain('Burlington');

    const logistics = jobs.find(
      (j) => j.title === 'Materials / Logistics Specialist',
    )!;
    expect(logistics.department).toBe('Logistics');
    expect(logistics.location?.displayLocation()).toContain('North Huntingdon');
  });

  it('ignores non-role /uploads PDFs (no "Title - Location" text)', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    expect(
      jobs.some((j) => /brochure/i.test(j.jobUrl ?? '')),
    ).toBe(false);
  });

  it('carries the PDF body into the description', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const logistics = jobs.find(
      (j) => j.title === 'Materials / Logistics Specialist',
    )!;
    expect(logistics.description).toContain('Position Summary');
    expect(logistics.description).toContain('Shipping');
  });

  it('takes each role pay interval from its own PDF label (yearly and hourly)', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());

    const mech = jobs.find((j) => j.title === 'Mechanical Engineer I')!;
    expect(mech.compensation?.minAmount).toBe(70000);
    expect(mech.compensation?.maxAmount).toBe(80000);
    expect(mech.compensation?.interval).toBe(CompensationInterval.YEARLY);

    const it = jobs.find((j) => j.title === 'Sr. IT Systems Engineer')!;
    expect(it.compensation?.minAmount).toBe(110000);
    expect(it.compensation?.maxAmount).toBe(150000);
    expect(it.compensation?.interval).toBe(CompensationInterval.YEARLY);

    const logistics = jobs.find(
      (j) => j.title === 'Materials / Logistics Specialist',
    )!;
    expect(logistics.compensation?.minAmount).toBe(22);
    expect(logistics.compensation?.maxAmount).toBe(25);
    expect(logistics.compensation?.interval).toBe(CompensationInterval.HOURLY);
  });

  it('detects employmentType and jobType from the PDF prose', async () => {
    const { jobs } = await serviceWith().scrape(inputFrom());
    const logistics = jobs.find(
      (j) => j.title === 'Materials / Logistics Specialist',
    )!;
    expect(logistics.employmentType).toBe('Full-time');
    expect(logistics.jobType).toEqual(['fulltime']);
  });

  it('degrades gracefully when a PDF cannot be fetched (keeps listing fields)', async () => {
    const service = serviceWith(LISTING_HTML, (url) =>
      /Materials/i.test(url) ? '' : PDF_TEXT_BY_SLUG[slugOf(url)] ?? '',
    );
    const { jobs } = await service.scrape(inputFrom());
    const logistics = jobs.find(
      (j) => j.title === 'Materials / Logistics Specialist',
    )!;
    expect(logistics).toBeDefined();
    expect(logistics.description).toBeNull();
    expect(logistics.compensation ?? null).toBeNull();
    expect(logistics.emails).toEqual(['jobs@desktopmetal.com']);
  });

  it('applies searchTerm and resultsWanted filters', async () => {
    const filtered = await serviceWith().scrape(
      inputFrom({ searchTerm: 'Systems Engineer' }),
    );
    expect(filtered.jobs).toHaveLength(1);
    expect(filtered.jobs[0].title).toBe('Sr. IT Systems Engineer');

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
