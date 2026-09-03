import { ScraperInputDto } from '@ever-jobs/models';
import { SuccessFactorsService } from '../src/successfactors.service';
import {
  htmlLooksLikeCsb,
  resolveCsbBaseUrl,
  buildSfCsbTileUrl,
  buildSfCsbDefaultOrigin,
  SF_CSB_JOB_LINK_RE,
} from '../src/successfactors.constants';

/**
 * A single Career Site Builder job tile, as emitted in `tile-search-results`.
 * The real portal repeats each tile across desktop/tablet/mobile variants, so
 * the fixture duplicates the anchor to exercise de-duplication.
 */
function tile(jobId: string, slug: string, title: string): string {
  const href = `/job/${slug}/${jobId}/`;
  const anchor = `<a class="jobTitle-link" href="${href}">${title}</a>`;
  return `
    <li class="job-tile job-id-${jobId}" data-url="${href}">
      <div class="sub-section-desktop">${anchor}</div>
      <div class="sub-section-tablet">${anchor}</div>
      <div class="sub-section-mobile">${anchor}</div>
    </li>`;
}

function tilePage(tiles: string[]): string {
  return `<!DOCTYPE html><html><body>
    <div id="tile-search-results"><ul>${tiles.join('')}</ul></div>
    <script src="/platform/bootstrap/foo.js"></script>
  </body></html>`;
}

/** A CSB detail page carrying schema.org JobPosting *microdata* (not JSON-LD). */
function detailPage(opts: {
  title: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  datePosted: string;
  hiringOrganization: string;
  descriptionHtml: string;
}): string {
  return `<!DOCTYPE html><html><body>
    <div itemscope itemtype="http://schema.org/JobPosting">
      <h1><span itemprop="title" data-careersite-propertyid="title">${opts.title}</span></h1>
      <span itemprop="jobLocation" itemscope itemtype="http://schema.org/Place">
        <span itemprop="address" itemscope itemtype="http://schema.org/PostalAddress">
          <meta itemprop="addressLocality" content="${opts.city}">
          <meta itemprop="addressRegion" content="${opts.state}">
          <meta itemprop="postalCode" content="${opts.postalCode}">
          <meta itemprop="addressCountry" content="${opts.country}">
        </span>
      </span>
      <meta itemprop="datePosted" content="${opts.datePosted}">
      <meta itemprop="validThrough" content="Tue Aug 11 04:00:00 UTC 2026">
      <meta itemprop="hiringOrganization" content="${opts.hiringOrganization}">
      <span itemprop="industry">Quality Engineer, Engineering</span>
      <span itemprop="description" data-careersite-propertyid="description">${opts.descriptionHtml}</span>
    </div>
  </body></html>`;
}

/**
 * Test double that serves captured HTML from the CSB fetch seams and forces the
 * OData path to yield nothing (so the CSB reader always runs).
 */
class TestSuccessFactorsService extends SuccessFactorsService {
  constructor(
    private readonly pages: Map<number, string>,
    private readonly details: Map<string, string>,
    private readonly probes: Map<string, string> = new Map(),
  ) {
    super();
  }

  protected async scrapeOData(): Promise<never[]> {
    return [];
  }

  protected async fetchCsbTileHtml(
    _base: string,
    startrow: number,
  ): Promise<string> {
    return this.pages.get(startrow) ?? tilePage([]);
  }

  protected async fetchCsbDetailHtml(url: string): Promise<string> {
    for (const [jobId, html] of this.details) {
      if (url.includes(`/${jobId}/`)) return html;
    }
    return '';
  }

  protected async fetchCsbProbeHtml(base: string): Promise<string> {
    return this.probes.get(base) ?? '';
  }
}

const DETAIL = detailPage({
  title: 'Quality Assurance Engineer',
  city: 'Springfield',
  state: 'IL',
  country: 'US',
  postalCode: '62704',
  datePosted: 'Mon Jul 13 00:00:00 UTC 2026',
  hiringOrganization: 'Northwind',
  descriptionHtml:
    '<p>Join us. Email <a href="mailto:jobs@northwind.example">jobs@northwind.example</a></p>',
});

describe('SuccessFactors constants (CSB helpers)', () => {
  it('resolves the CSB base to the portal origin', () => {
    expect(resolveCsbBaseUrl('https://careers.northwind.example/search/?q=')).toBe(
      'https://careers.northwind.example',
    );
    expect(resolveCsbBaseUrl('not-a-url')).toBeNull();
    expect(resolveCsbBaseUrl(undefined)).toBeNull();
  });

  it('builds a tile-search-results URL with pagination', () => {
    const url = buildSfCsbTileUrl('https://careers.northwind.example', 25);
    expect(url).toContain('/tile-search-results/');
    expect(url).toContain('startrow=25');
    expect(url).toContain('sortColumn=referencedate');
  });

  it('extracts the numeric job id from a detail path (ignores zip in slug)', () => {
    const m = SF_CSB_JOB_LINK_RE.exec(
      '/job/Springfield-Quality-Assurance-Engineer-IL-62704/1408182200/',
    );
    expect(m?.[1]).toBe('1408182200');
  });

  it('recognises a CSB page by content fingerprints on a custom domain', () => {
    expect(htmlLooksLikeCsb(tilePage([tile('1', 'Foo-OH', 'Foo')]))).toBe(true);
    expect(htmlLooksLikeCsb('<html><body>marketing site</body></html>')).toBe(
      false,
    );
  });

  it('builds a default CSB origin from a bare companyId', () => {
    expect(buildSfCsbDefaultOrigin('acme')).toBe(
      'https://acme.jobs.hr.cloud.sap',
    );
    expect(buildSfCsbDefaultOrigin('')).toBeNull();
  });
});

describe('SuccessFactorsService — Career Site Builder reader', () => {
  it('maps tiles + detail microdata into JobPostDto (custom-domain, no OData)', async () => {
    const pages = new Map<number, string>([
      [
        0,
        tilePage([
          tile(
            '1408182200',
            'Springfield-Quality-Assurance-Engineer-IL-62704',
            'Quality Assurance Engineer',
          ),
        ]),
      ],
    ]);
    const details = new Map<string, string>([['1408182200', DETAIL]]);
    const svc = new TestSuccessFactorsService(pages, details);

    const input = new ScraperInputDto();
    input.companyUrl = 'https://careers.northwind.example/';
    input.resultsWanted = 10;

    const res = await svc.scrape(input);
    expect(res.jobs).toHaveLength(1);

    const job = res.jobs[0];
    expect(job.title).toBe('Quality Assurance Engineer');
    expect(job.companyName).toBe('Northwind');
    expect(job.atsId).toBe('1408182200');
    expect(job.atsType).toBe('successfactors');
    expect(job.site).toBe('successfactors');
    expect(job.jobUrl).toBe(
      'https://careers.northwind.example/job/Springfield-Quality-Assurance-Engineer-IL-62704/1408182200/',
    );
    expect(job.location?.city).toBe('Springfield');
    expect(job.location?.state).toBe('IL');
    expect(job.datePosted).toBe('2026-07-13');
    expect(job.description).toContain('Join us');
    expect(job.emails).toContain('jobs@northwind.example');
  });

  it('paginates across tile pages and de-dupes repeated anchors', async () => {
    const pages = new Map<number, string>([
      [
        0,
        tilePage([
          tile('100', 'A-OH', 'Alpha'),
          tile('101', 'B-OH', 'Beta'),
        ]),
      ],
      [25, tilePage([tile('102', 'C-OH', 'Gamma')])],
    ]);
    const svc = new TestSuccessFactorsService(pages, new Map());

    const input = new ScraperInputDto();
    input.companyUrl = 'https://careers.example.com';
    input.resultsWanted = 50;

    const res = await svc.scrape(input);
    expect(res.jobs.map((j) => j.atsId).sort()).toEqual(['100', '101', '102']);
  });

  it('honours resultsWanted', async () => {
    const pages = new Map<number, string>([
      [
        0,
        tilePage([
          tile('1', 'A-OH', 'A'),
          tile('2', 'B-OH', 'B'),
          tile('3', 'C-OH', 'C'),
        ]),
      ],
    ]);
    const svc = new TestSuccessFactorsService(pages, new Map());

    const input = new ScraperInputDto();
    input.companyUrl = 'https://careers.example.com';
    input.resultsWanted = 2;

    const res = await svc.scrape(input);
    expect(res.jobs).toHaveLength(2);
  });

  it('falls back to the tile title when a detail page is missing', async () => {
    const pages = new Map<number, string>([
      [0, tilePage([tile('900', 'Solo-OH', 'Solo Role')])],
    ]);
    const svc = new TestSuccessFactorsService(pages, new Map());

    const input = new ScraperInputDto();
    input.companyUrl = 'https://careers.example.com';

    const res = await svc.scrape(input);
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Solo Role');
  });

  it('falls back to a default SAP CSB origin for a bare slug with no companyUrl', async () => {
    const probeBase = 'https://acme.jobs.hr.cloud.sap';
    const pages = new Map<number, string>([
      [
        0,
        tilePage([
          tile(
            '1408182200',
            'Springfield-Quality-Assurance-Engineer-IL-62704',
            'Quality Assurance Engineer',
          ),
        ]),
      ],
    ]);
    const details = new Map<string, string>([['1408182200', DETAIL]]);
    const probes = new Map<string, string>([[probeBase, pages.get(0)!]]);

    const svc = new TestSuccessFactorsService(pages, details, probes);

    const input = new ScraperInputDto();
    input.companySlug = 'acme';
    input.resultsWanted = 10;

    const res = await svc.scrape(input);
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Quality Assurance Engineer');
  });

  it('returns a diagnostic when a bare slug has no verifiable default CSB origin', async () => {
    const svc = new TestSuccessFactorsService(
      new Map(),
      new Map(),
      new Map([['https://acme.jobs.hr.cloud.sap', '<html><body>marketing site</body></html>']]),
    );

    const input = new ScraperInputDto();
    input.companySlug = 'acme';

    const res = await svc.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics).toBeDefined();
    expect(res.diagnostics?.reason).toBe('bad_input');
    expect(res.diagnostics?.detail).toMatch(/missing companyUrl/);
  });

  it('reports `empty`, not `bad_input`, when the derived CSB portal is real but has no postings', async () => {
    // The probe passes, so `companyUrl` was never the problem: the portal was
    // found and read, and the board simply had nothing on it. Blaming the
    // caller's input here sends whoever reads the diagnostic to the wrong fix.
    const probeBase = 'https://acme.jobs.hr.cloud.sap';
    const svc = new TestSuccessFactorsService(
      // No tile pages: the portal answers, and has nothing listed.
      new Map(),
      new Map(),
      new Map([[probeBase, tilePage([tile('1', 'a-role', 'A Role')])]]),
    );

    const input = new ScraperInputDto();
    input.companySlug = 'acme';

    const res = await svc.scrape(input);
    expect(res.jobs).toHaveLength(0);
    expect(res.diagnostics?.reason).toBe('empty');
    expect(res.diagnostics?.detail).toContain(probeBase);
  });

  it('still honours a colon slug paired with an explicit companyUrl', async () => {
    const pages = new Map<number, string>([
      [0, tilePage([tile('1408182200', 'A-OH', 'Alpha')])],
    ]);
    const svc = new TestSuccessFactorsService(pages, new Map());

    const input = new ScraperInputDto();
    input.companySlug = 'sap:ACME';
    input.companyUrl = 'https://careers.example.com';
    input.resultsWanted = 10;

    const res = await svc.scrape(input);
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].title).toBe('Alpha');
  });

  it('returns empty when neither companySlug nor companyUrl is provided', async () => {
    const svc = new TestSuccessFactorsService(new Map(), new Map());
    const res = await svc.scrape(new ScraperInputDto());
    expect(res.jobs).toHaveLength(0);
  });

  it('returns empty for a portal with no job tiles', async () => {
    const svc = new TestSuccessFactorsService(new Map(), new Map());
    const input = new ScraperInputDto();
    input.companyUrl = 'https://careers.example.com';
    const res = await svc.scrape(input);
    expect(res.jobs).toHaveLength(0);
  });

  it('fetches tile pages in concurrent batches and stops on the first empty page', async () => {
    const pages = new Map<number, string>([
      [0, tilePage([tile('100', 'A-OH', 'Alpha'), tile('101', 'B-OH', 'Beta')])],
      [25, tilePage([tile('102', 'C-OH', 'Gamma')])],
      [50, tilePage([])],
    ]);
    const svc = new TestSuccessFactorsService(pages, new Map());

    const input = new ScraperInputDto();
    input.companyUrl = 'https://careers.example.com';
    input.resultsWanted = 50;

    const res = await svc.scrape(input);
    expect(res.jobs.map((j) => j.atsId).sort()).toEqual(['100', '101', '102']);
  });

  it('stops when a concurrent batch contains a duplicate-only page', async () => {
    const pages = new Map<number, string>([
      [0, tilePage([tile('100', 'A-OH', 'Alpha')])],
      [25, tilePage([tile('100', 'A-OH', 'Alpha')])],
      [50, tilePage([tile('101', 'B-OH', 'Beta')])],
    ]);
    const svc = new TestSuccessFactorsService(pages, new Map());

    const input = new ScraperInputDto();
    input.companyUrl = 'https://careers.example.com';
    input.resultsWanted = 50;

    const res = await svc.scrape(input);
    expect(res.jobs.map((j) => j.atsId).sort()).toEqual(['100']);
  });

  it('fetches CSB detail pages with bounded concurrency', async () => {
    const tiles = Array.from({ length: 20 }, (_, i) =>
      tile(String(i + 1), `role-${i + 1}-OH`, `Role ${i + 1}`),
    );
    const pages = new Map<number, string>([[0, tilePage(tiles)]]);
    const details = new Map<string, string>();
    for (let i = 1; i <= 20; i++) {
      details.set(String(i), DETAIL);
    }

    let active = 0;
    let maxActive = 0;

    class ConcurrencyService extends TestSuccessFactorsService {
      protected async fetchCsbDetailHtml(url: string): Promise<string> {
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return super.fetchCsbDetailHtml(url);
        } finally {
          active -= 1;
        }
      }
    }

    const svc = new ConcurrencyService(pages, details);
    const input = new ScraperInputDto();
    input.companyUrl = 'https://careers.example.com';
    input.resultsWanted = 20;

    const res = await svc.scrape(input);
    expect(res.jobs).toHaveLength(20);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(10);
  });
});
