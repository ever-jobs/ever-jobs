/**
 * Unit tests for the five delegating company-source scaffolders
 * (`scaffold-{ashby,lever,recruitee,smartrecruiters,workable}-company-source.ts`).
 *
 * These generators produced 699 of the plugins in the tree and, until Spec 1680,
 * had **no tests at all** — so nothing pinned the code they emit. That matters
 * more than usual here: a delegating plugin returns its backend's result
 * verbatim, and its only independent failure path is the registry miss. That
 * path emitted a bare `new JobResponseDto([])`, which upstream is
 * indistinguishable from a board that genuinely had no postings.
 *
 * One parameterised suite rather than five near-identical files: the emitted
 * shape is the same across backends, and a single table makes a drift between
 * them obvious.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { scaffoldOne as scaffoldAshby } from '../scaffold-ashby-company-source';
import { scaffoldOne as scaffoldLever } from '../scaffold-lever-company-source';
import { scaffoldOne as scaffoldRecruitee } from '../scaffold-recruitee-company-source';
import { scaffoldOne as scaffoldSmartRecruiters } from '../scaffold-smartrecruiters-company-source';
import { scaffoldOne as scaffoldWorkable } from '../scaffold-workable-company-source';

/** The descriptor shape is structurally identical across the five backends. */
function makeDescriptor(): any {
  return {
    slug: 'testcorp',
    companySlug: 'test-corp',
    className: 'Testcorp',
    moduleName: 'TestcorpModule',
    serviceName: 'TestcorpService',
    enumKey: 'TESTCORP',
    displayName: 'Test Corp',
    specNo: 9999,
    phaseNo: 1,
    jobCount: 3,
    oneLiner: 'Widget maker',
    sector: 'Manufacturing',
    hq: 'Nowhere, USA',
    description: 'Test Corp builds widgets. It operates the Engineering function.',
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
        title: 'Widget Technician',
        location: 'Austin, TX',
        department: 'Operations',
        updatedAt: '2026-06-01T00:00:00+00:00',
      },
    ],
  };
}

const BACKENDS: Array<[string, (root: string, d: any) => void, string]> = [
  ['ashby', scaffoldAshby, 'Ashby'],
  ['lever', scaffoldLever, 'Lever'],
  ['recruitee', scaffoldRecruitee, 'Recruitee'],
  ['smartrecruiters', scaffoldSmartRecruiters, 'SmartRecruiters'],
  ['workable', scaffoldWorkable, 'Workable'],
];

describe('delegating company-source scaffolders', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ever-jobs-deleg-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Generate for one backend and return the emitted service source. */
  function emitService(scaffold: (root: string, d: any) => void): string {
    scaffold(root, makeDescriptor());
    return fs.readFileSync(
      path.join(root, 'packages', 'plugins', 'source-company-testcorp', 'src', 'testcorp.service.ts'),
      'utf8',
    );
  }

  describe.each(BACKENDS)('%s', (_key, scaffold, label) => {
    it('emits a service that compiles-shaped delegation to its backend', () => {
      const svc = emitService(scaffold);

      expect(svc).toContain('export class TestcorpService implements IScraper');
      expect(svc).toContain('this.registry?.getScraper(');
    });

    /**
     * Spec 1680. A registry miss is a wiring problem, not an empty board, and
     * the bare `new JobResponseDto([])` these emitted before reported it as the
     * latter.
     */
    it('reports a registry miss as not_registered rather than a bare empty result', () => {
      const svc = emitService(scaffold);

      expect(svc).toContain('ScrapeDiagnostics,');
      expect(svc).toContain(`new ScrapeDiagnostics('not_registered', '${label} source plugin is not registered')`);
      expect(svc).not.toContain('return new JobResponseDto([]);');
    });

    it('never emits the swallowed-error shape', () => {
      const svc = emitService(scaffold);

      expect(svc).not.toContain('return { jobs };');
    });
  });

  it('emits the same not_registered contract across every backend', () => {
    const shapes = BACKENDS.map(([, scaffold]) => {
      const svc = emitService(scaffold);
      fs.rmSync(path.join(root, 'packages'), { recursive: true, force: true });
      return svc.includes("new ScrapeDiagnostics('not_registered'");
    });

    expect(shapes).toEqual([true, true, true, true, true]);
  });
});
