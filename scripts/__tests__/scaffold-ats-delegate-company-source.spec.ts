/**
 * Unit tests for `scripts/scaffold-ats-delegate-company-source.ts` (Spec 1735).
 *
 * The generated plugins are exercised by their own suites; these tests pin the
 * generator's contract: no plugin without a live verification record, one
 * backend per plugin, the exact files emitted (and nothing under `.specify/`),
 * the delegation code shape (registry lookup, per-board id rewrite, sequential
 * boards with the remaining budget, not_registered on a registry miss), the
 * tag line, and fixtures that reproduce the adapter's own URLs and ids.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  assembleDescriptors,
  AtsDelegateDescriptor,
  BACKENDS,
  fixtureFile,
  renderVerificationTable,
  scaffoldOne,
  SeedDescriptor,
  serviceFile,
  tagLine,
  tagSlug,
  testFile,
  VerificationFile,
  workdayReqId,
} from '../scaffold-ats-delegate-company-source';

function seed(overrides: Partial<SeedDescriptor> = {}): SeedDescriptor {
  return {
    key: 'acme',
    enumKey: 'ACME',
    className: 'Acme',
    displayName: "Acme & Sons' Corp",
    segment: 'workday-enterprise',
    industry: 'Aerospace and defense',
    hq: 'Austin, TX, USA',
    companyDomains: ['acme.com'],
    specNo: 1736,
    boards: [
      { backend: 'workday', slug: 'acme:5:Acme_Early', label: 'early careers' },
      { backend: 'workday', slug: 'acme:5:Acme' },
    ],
    ...overrides,
  };
}

const VERIFICATION: VerificationFile = {
  boards: {
    'workday:acme:5:Acme_Early': {
      backend: 'workday',
      slug: 'acme:5:Acme_Early',
      url: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Acme_Early/jobs',
      status: 200,
      jobCount: 12,
      verifiedAt: '2026-09-24',
      listings: [
        {
          id: 'R-1',
          title: 'Software Engineer Intern',
          location: 'Austin, TX',
          department: null,
          updatedAt: null,
          externalPath: '/job/Austin-TX/Software-Engineer-Intern_R-1',
          postedOn: 'Posted Today',
          bulletFields: ['R-1'],
        },
      ],
    },
    'workday:acme:5:Acme': {
      backend: 'workday',
      slug: 'acme:5:Acme',
      url: 'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Acme/jobs',
      status: 200,
      jobCount: 1234,
      verifiedAt: '2026-09-24',
      listings: [
        {
          id: '/job/Remote/Staff-Engineer_JR99-2',
          title: 'Staff Engineer',
          location: '2 Locations',
          department: null,
          updatedAt: null,
          externalPath: '/job/Remote/Staff-Engineer_JR99-2',
          postedOn: 'Posted 30+ Days Ago',
          bulletFields: null,
        },
      ],
    },
    'greenhouse:acmetrading': {
      backend: 'greenhouse',
      slug: 'acmetrading',
      url: 'https://api.greenhouse.io/v1/boards/acmetrading/jobs',
      status: 200,
      jobCount: 2,
      verifiedAt: '2026-09-24',
      listings: [
        { id: '4001', title: 'Quant Trader Intern', location: 'Chicago, IL', department: null, updatedAt: null },
        { id: '4002', title: 'C++ Developer', location: null, department: 'Tech', updatedAt: '2026-09-01T00:00:00.000Z' },
      ],
    },
    'icims:careers-acme': {
      backend: 'icims',
      slug: 'careers-acme',
      url: 'https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1',
      status: 200,
      jobCount: 20,
      verifiedAt: '2026-09-24',
      listings: [{ id: '777', title: 'Trading Intern <Summer>', location: null, department: null, updatedAt: null }],
    },
  },
};

describe('assembleDescriptors', () => {
  it('joins seed and verification records in board order', () => {
    const [d] = assembleDescriptors([seed()], VERIFICATION);
    expect(d.moduleName).toBe('AcmeModule');
    expect(d.serviceName).toBe('AcmeService');
    expect(d.boards.map((b) => [b.slug, b.jobCount, b.label])).toEqual([
      ['acme:5:Acme_Early', 12, 'early careers'],
      ['acme:5:Acme', 1234, undefined],
    ]);
  });

  it('refuses a board with no live verification record', () => {
    expect(() =>
      assembleDescriptors([seed({ boards: [{ backend: 'workday', slug: 'acme:5:Unverified' }] })], VERIFICATION),
    ).toThrow(/no live verification record/);
    const failed: VerificationFile = {
      boards: { 'workday:acme:5:Acme': { ...VERIFICATION.boards['workday:acme:5:Acme'], status: 422 } },
    };
    expect(() =>
      assembleDescriptors([seed({ boards: [{ backend: 'workday', slug: 'acme:5:Acme' }] })], failed),
    ).toThrow(/no live verification record/);
  });

  it('rejects mixed backends, duplicate keys, bad names and www. domains', () => {
    expect(() =>
      assembleDescriptors(
        [seed({ boards: [{ backend: 'workday', slug: 'acme:5:Acme' }, { backend: 'greenhouse', slug: 'acmetrading' }] })],
        VERIFICATION,
      ),
    ).toThrow(/mix backends/);
    expect(() => assembleDescriptors([seed(), seed()], VERIFICATION)).toThrow(/duplicate key/);
    expect(() => assembleDescriptors([seed({ key: 'Bad-Key' })], VERIFICATION)).toThrow(/bad key/);
    expect(() => assembleDescriptors([seed({ enumKey: '3M' })], VERIFICATION)).toThrow(/bad enumKey/);
    expect(() => assembleDescriptors([seed({ companyDomains: ['www.acme.com'] })], VERIFICATION)).toThrow(
      /companyDomains/,
    );
  });

  it('honours an --only filter', () => {
    const out = assembleDescriptors(
      [seed(), seed({ key: 'other', enumKey: 'OTHER', className: 'Other', boards: [{ backend: 'greenhouse', slug: 'acmetrading' }] })],
      VERIFICATION,
      ['other'],
    );
    expect(out.map((d) => d.key)).toEqual(['other']);
  });
});

describe('tags', () => {
  it('renders a machine-greppable tag line', () => {
    expect(tagSlug('Aerospace and defense')).toBe('aerospace-and-defense');
    expect(tagSlug('Semiconductors & infrastructure software')).toBe('semiconductors-and-infrastructure-software');
    expect(tagLine({ segment: 'quant-trading', industry: 'Market making' })).toBe(
      'Tags: segment=quant-trading; industry=market-making.',
    );
  });
});

describe('serviceFile', () => {
  const [d] = assembleDescriptors([seed()], VERIFICATION);
  const src = serviceFile(d);

  it('delegates through the registry, never importing the ATS plugin', () => {
    expect(src).toContain('this.registry?.getScraper(Site.WORKDAY)');
    expect(src).not.toMatch(/from '@ever-jobs\/source-ats-/);
    expect(src).toContain("new ScrapeDiagnostics('not_registered', 'Workday source plugin is not registered')");
  });

  it('lists the boards in order with their adapter id prefixes', () => {
    const early = src.indexOf("{ companySlug: 'acme:5:Acme_Early', atsIdPrefix: 'wd-acme-' }");
    const main = src.indexOf("{ companySlug: 'acme:5:Acme', atsIdPrefix: 'wd-acme-' }");
    expect(early).toBeGreaterThan(0);
    expect(main).toBeGreaterThan(early);
  });

  it('declares a tagged company plugin and escapes the display name', () => {
    expect(src).toContain('site: Site.ACME,');
    expect(src).toContain("category: 'company',");
    expect(src).toContain("companyDomains: ['acme.com'],");
    expect(src).toContain("const COMPANY_NAME = 'Acme & Sons\\' Corp';");
    expect(src).toContain('Tags: segment=workday-enterprise; industry=aerospace-and-defense.');
  });

  it('spends only the remaining budget and keeps actionable diagnostics', () => {
    expect(src).toContain('const remaining = wanted == null ? undefined : wanted - jobs.length;');
    expect(src).toContain('ACTIONABLE_SCRAPE_REASONS.includes(diagnostics.reason)');
    expect(src).toContain('classifyScrapeError(err)');
    expect(src).not.toContain('console.log');
  });
});

describe('fixtureFile', () => {
  it('reproduces the Workday search and detail URLs and the ids the adapter derives', () => {
    const [d] = assembleDescriptors([seed()], VERIFICATION);
    const fx = JSON.parse(fixtureFile(d));
    expect(fx.boards).toEqual([
      { input: { companySlug: 'acme:5:Acme_Early' }, atsIdPrefix: 'wd-acme-' },
      { input: { companySlug: 'acme:5:Acme' }, atsIdPrefix: 'wd-acme-' },
    ]);
    expect(Object.keys(fx.responses)).toEqual([
      'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Acme_Early/jobs',
      'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Acme_Early/job/Austin-TX/Software-Engineer-Intern_R-1',
      'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Acme/jobs',
      'https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Acme/job/Remote/Staff-Engineer_JR99-2',
    ]);
    // bullet field first, else the externalPath tail after the last underscore.
    expect(fx.expected).toEqual([
      { id: 'acme-R-1', title: 'Software Engineer Intern' },
      { id: 'acme-JR99-2', title: 'Staff Engineer' },
    ]);
    // The ATS organisation label differs from the display name, so only the
    // plugin's re-stamp can produce the company name the suite asserts.
    const detail = fx.responses['https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Acme/job/Remote/Staff-Engineer_JR99-2'];
    expect(detail.hiringOrganization.name).toBe('acme');
  });

  it('keys Greenhouse and iCIMS responses by the adapter URL without query', () => {
    const [gh] = assembleDescriptors(
      [seed({ key: 'acmetrading', enumKey: 'ACMETRADING', className: 'AcmeTrading', boards: [{ backend: 'greenhouse', slug: 'acmetrading' }] })],
      VERIFICATION,
    );
    const ghFx = JSON.parse(fixtureFile(gh));
    expect(Object.keys(ghFx.responses)).toEqual(['https://api.greenhouse.io/v1/boards/acmetrading/jobs']);
    expect(ghFx.responses['https://api.greenhouse.io/v1/boards/acmetrading/jobs'].jobs[0].id).toBe(4001);
    expect(ghFx.expected.map((e: { id: string }) => e.id)).toEqual(['acmetrading-4001', 'acmetrading-4002']);

    const [ic] = assembleDescriptors(
      [seed({ key: 'acmeic', enumKey: 'ACMEIC', className: 'AcmeIc', boards: [{ backend: 'icims', slug: 'careers-acme' }] })],
      VERIFICATION,
    );
    const icFx = JSON.parse(fixtureFile(ic));
    const html: string = icFx.responses['https://careers-acme.icims.com/jobs/search'];
    expect(html).toContain('iCIMS_JobCardItem');
    expect(html).toContain('<h3>Trading Intern &lt;Summer&gt;</h3>');
    expect(icFx.boards[0].atsIdPrefix).toBe('icims-careers-acme-');
  });

  it('derives the Workday requisition id defensively', () => {
    expect(workdayReqId({ id: 'x', title: 't', location: null, department: null, updatedAt: null, bulletFields: [' R-7 '] })).toBe('R-7');
    expect(workdayReqId({ id: 'fallback', title: 't', location: null, department: null, updatedAt: null, externalPath: '' })).toBe('fallback');
  });
});

describe('testFile', () => {
  it('emits the multi-board block only for multi-board plugins', () => {
    const [multi] = assembleDescriptors([seed()], VERIFICATION);
    const [single] = assembleDescriptors(
      [seed({ boards: [{ backend: 'workday', slug: 'acme:5:Acme' }] })],
      VERIFICATION,
    );
    expect(testFile(multi)).toContain("describe('multiple boards'");
    expect(testFile(single)).not.toContain("describe('multiple boards'");
    expect(testFile(single)).toContain("import { WorkdayService } from '@ever-jobs/source-ats-workday';");
    expect(testFile(single)).toContain("expect(result.diagnostics?.reason).toBe('bad_input');");
  });

  it('does not assert a 404 reason for iCIMS, which degrades to a bare empty result', () => {
    const [ic] = assembleDescriptors(
      [seed({ key: 'acmeic', enumKey: 'ACMEIC', className: 'AcmeIc', boards: [{ backend: 'icims', slug: 'careers-acme' }] })],
      VERIFICATION,
    );
    expect(testFile(ic)).not.toContain("toBe('bad_input')");
    expect(BACKENDS.icims.notFoundReason).toBeNull();
  });
});

describe('scaffoldOne', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-delegate-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes exactly the seven package files and nothing under .specify/', () => {
    const [d]: AtsDelegateDescriptor[] = assembleDescriptors([seed()], VERIFICATION);
    const written = scaffoldOne(root, d).map((p) => path.relative(root, p).split(path.sep).join('/'));
    expect(written.sort()).toEqual(
      [
        'packages/plugins/source-company-acme/__tests__/acme.service.spec.ts',
        'packages/plugins/source-company-acme/__tests__/fixtures/acme-boards.json',
        'packages/plugins/source-company-acme/package.json',
        'packages/plugins/source-company-acme/src/acme.module.ts',
        'packages/plugins/source-company-acme/src/acme.service.ts',
        'packages/plugins/source-company-acme/src/index.ts',
        'packages/plugins/source-company-acme/tsconfig.json',
      ].sort(),
    );
    expect(fs.existsSync(path.join(root, '.specify'))).toBe(false);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/plugins/source-company-acme/package.json'), 'utf8'));
    expect(pkg.name).toBe('@ever-jobs/source-company-acme');
  });
});

describe('renderVerificationTable', () => {
  it('renders one row per board with platform, slug, date and job count', () => {
    const table = renderVerificationTable(assembleDescriptors([seed()], VERIFICATION));
    expect(table).toContain(
      "| `acme` | Acme & Sons' Corp | Workday | `acme:5:Acme_Early` (early careers) | 2026-09-24 | 12 |",
    );
    expect(table).toContain('| `acme` | Acme & Sons\' Corp | Workday | `acme:5:Acme` | 2026-09-24 | 1,234 |');
  });

  it('marks a first-listing-page count (iCIMS) as a lower bound, in the table and the doc comment', () => {
    const [ic] = assembleDescriptors(
      [seed({ key: 'acmeic', enumKey: 'ACMEIC', className: 'AcmeIc', boards: [{ backend: 'icims', slug: 'careers-acme' }] })],
      VERIFICATION,
    );
    expect(renderVerificationTable([ic])).toContain('| `careers-acme` | 2026-09-24 | 20+ |');
    expect(serviceFile(ic)).toContain('verified live 2026-09-24: 20+ open postings (first listing page).');
    const [wd] = assembleDescriptors([seed()], VERIFICATION);
    expect(serviceFile(wd)).toContain('verified live 2026-09-24: 1,234 open postings.');
  });
});
