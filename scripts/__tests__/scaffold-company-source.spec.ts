/**
 * Unit tests for `scripts/scaffold-company-source.ts`.
 *
 * The scaffolder is the deterministic generator behind the run-398 batch of
 * Greenhouse company-direct source plugins. These tests pin its contract:
 * it emits exactly the 10-file package + spec layout into a throwaway repo
 * root, and the generated service / test / fixture carry the descriptor's
 * slug, enum key, class names, and variant-2 URL shape.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { scaffoldOne, CompanyDescriptor } from '../scaffold-company-source';

function makeDescriptor(over: Partial<CompanyDescriptor> = {}): CompanyDescriptor {
  return {
    slug: 'testcorp',
    className: 'Testcorp',
    moduleName: 'TestcorpModule',
    serviceName: 'TestcorpService',
    enumKey: 'TESTCORP',
    displayName: 'Test Corp',
    specNo: 900,
    phaseNo: 910,
    jobCount: 7,
    description: 'Test Corp builds widgets. It operates the Engineering function.',
    oneLiner: 'Widget maker',
    sector: 'Manufacturing',
    hq: 'Nowhere, USA',
    highlights: ['Builds widgets', 'Hires in Engineering'],
    listings: [
      {
        id: 111,
        title: 'Senior Widget Engineer',
        location: 'Remote, United States',
        department: 'Engineering',
        updatedAt: '2026-06-01T00:00:00+00:00',
      },
      {
        id: 222,
        title: 'Widget Designer',
        location: 'Berlin, Germany',
        department: 'Design',
        updatedAt: '2026-06-01T00:00:00+00:00',
      },
      {
        id: 333,
        title: 'Open Application',
        location: 'London, UK',
        department: null,
        updatedAt: '2026-06-01T00:00:00+00:00',
      },
    ],
    ...over,
  };
}

describe('scaffold-company-source', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ever-jobs-scaffold-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('emits the full 10-file package + spec layout', () => {
    const d = makeDescriptor();
    const written = scaffoldOne(root, d);
    expect(written).toHaveLength(10);
    for (const f of written) {
      expect(fs.existsSync(f)).toBe(true);
    }
    const pkgDir = path.join(root, 'packages', 'plugins', 'source-company-testcorp');
    expect(fs.existsSync(path.join(pkgDir, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(pkgDir, 'src', 'testcorp.service.ts'))).toBe(true);
    expect(
      fs.existsSync(path.join(pkgDir, '__tests__', 'fixtures', 'testcorp-jobs.json')),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(root, '.specify', 'specs', '900-source-company-testcorp', 'spec.md')),
    ).toBe(true);
  });

  it('wires the enum key, class names, and variant-2 URL into the service', () => {
    const d = makeDescriptor();
    scaffoldOne(root, d);
    const svc = fs.readFileSync(
      path.join(root, 'packages', 'plugins', 'source-company-testcorp', 'src', 'testcorp.service.ts'),
      'utf8',
    );
    expect(svc).toContain('site: Site.TESTCORP,');
    expect(svc).toContain('export class TestcorpService implements IScraper');
    expect(svc).toContain("name: 'Test Corp',");
    expect(svc).toContain('https://api.greenhouse.io/v1/boards/testcorp/jobs');
    expect(svc).toContain('https://job-boards.greenhouse.io/testcorp/jobs/');
    // defensive trims present
    expect(svc).toContain("(listing.title ?? '').trim()");
    expect(svc).toContain('deptRaw ? deptRaw.trim() : null');

    // Spec 1680 - the generator must not mint the swallowed-error shape again.
    // 822 services in the tree carry `return { jobs };`, which reports every
    // failure as an indistinguishable empty board.
    expect(svc).toContain('classifyScrapeError(err)');
    expect(svc).toContain('return new JobResponseDto(jobs, classifyScrapeError(err));');
    expect(svc).toContain('return new JobResponseDto(jobs);');
    expect(svc).not.toContain('return { jobs };');
  });

  it('forces trailing-pad on fixture listing[0] title and department, and empties null departments', () => {
    const d = makeDescriptor();
    scaffoldOne(root, d);
    const fixture = JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          'packages',
          'plugins',
          'source-company-testcorp',
          '__tests__',
          'fixtures',
          'testcorp-jobs.json',
        ),
        'utf8',
      ),
    );
    expect(fixture.jobs).toHaveLength(3);
    // listing[0] padded so the D-10/D-11 trim is always exercised.
    expect(fixture.jobs[0].title).toMatch(/\s$/);
    expect(fixture.jobs[0].departments[0].name).toMatch(/\s$/);
    // null department becomes an empty array.
    expect(fixture.jobs[2].departments).toEqual([]);
    // content carries encoded entities + tags + the company name.
    expect(fixture.jobs[0].content).toContain('&lt;p&gt;');
    expect(fixture.jobs[0].content).toContain('Test Corp');
  });

  it('generates a spec.md with a frontmatter table directly after the H1', () => {
    const d = makeDescriptor();
    scaffoldOne(root, d);
    const spec = fs.readFileSync(
      path.join(root, '.specify', 'specs', '900-source-company-testcorp', 'spec.md'),
      'utf8',
    );
    expect(spec.startsWith('# Spec: 900 — Source Company Plugin: Test Corp')).toBe(true);
    expect(spec).toContain('| Field          | Value');
    expect(spec).toContain("Add `Site.TESTCORP = 'testcorp'`");
  });
});
