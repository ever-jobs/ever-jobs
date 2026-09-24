/**
 * scaffold-ats-delegate-company-source.ts — Spec 1735
 *
 * Deterministic generator for **ATS-delegating company-direct** source plugins
 * whose boards were verified live by `scripts/probe-ats-delegate-company-source.ts`.
 * One generator for every supported backend (Workday, Greenhouse, Lever, Ashby,
 * SmartRecruiters, iCIMS), where the older per-backend scaffolders
 * (`scaffold-{ashby,lever,recruitee,smartrecruiters,workable}-company-source.ts`)
 * each cover one — and none covers Workday, Greenhouse delegation or iCIMS.
 *
 * Inputs (both committed under `scripts/seeds/`):
 *   - a seed file: `SeedDescriptor[]` — naming, company metadata, tags, the
 *     batch spec number and the board(s) each plugin delegates to;
 *   - a verification file: the merged probe record, keyed `backend:slug`.
 * `assembleDescriptors` joins them and REFUSES a board that has no live
 * verification record, so an unverified board can never become a plugin.
 *
 * For each descriptor it emits:
 *
 *   packages/plugins/source-company-<key>/
 *     package.json, tsconfig.json
 *     src/index.ts, src/<key>.module.ts, src/<key>.service.ts
 *     __tests__/<key>.service.spec.ts
 *     __tests__/fixtures/<key>-boards.json   (recorded listings -> HTTP responses)
 *
 * What differs from the older scaffolders:
 *   - **Multi-board**: a plugin may delegate to several boards of one ATS
 *     (e.g. an early-careers site plus the main site). Boards are scraped
 *     sequentially, early-career first, each with the remaining
 *     `resultsWanted` budget; ids are de-duplicated across boards; an
 *     actionable diagnostic from any board is kept (so a partial outage is
 *     visible), and a board that throws is classified rather than rethrown.
 *   - **No per-plugin spec directory**: the plugins of one batch share one
 *     batch spec (`specNo`), so this generator never writes under `.specify/`.
 *     `renderVerificationTable` renders the per-board verification table that
 *     the batch spec embeds.
 *   - **Tags**: `@SourcePlugin.description` carries a machine-greppable
 *     `Tags: segment=<segment>; industry=<industry>` suffix, since
 *     `IPluginMetadata` has no tag field (see docs/questions.md Q-108).
 *
 * Like its siblings it never touches the four shared wiring files; those are
 * appended by `scripts/wire-company-source-tail.ts`.
 *
 * Usage (via ts-node):
 *   ts-node --project tsconfig.base.json -r tsconfig-paths/register \
 *     scripts/scaffold-ats-delegate-company-source.ts \
 *     scripts/seeds/ats-delegate-companies.json \
 *     scripts/seeds/ats-delegate-company-verification.json [key,key,...]
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  workdayRequisitionId,
  type DelegateBackend,
  type ProbedListing,
} from './probe-ats-delegate-company-source';

export interface SeedBoard {
  backend: DelegateBackend;
  slug: string;
  /** Optional human label, e.g. `early careers`. */
  label?: string;
}

export interface SeedDescriptor {
  /** Plugin dir suffix, `Site` value and job-id prefix, e.g. `salesforce`. */
  key: string;
  enumKey: string;
  className: string;
  displayName: string;
  /** Company-tier segment tag, e.g. `workday-enterprise`, `quant-trading`. */
  segment: string;
  industry: string;
  hq: string;
  companyDomains: string[];
  /** The batch spec this plugin belongs to. */
  specNo: number;
  /** Boards in scrape order (early-career first). One backend per plugin. */
  boards: SeedBoard[];
}

export interface VerificationRecord {
  backend: DelegateBackend;
  slug: string;
  url: string;
  status: number | null;
  jobCount: number;
  verifiedAt: string;
  listings: ProbedListing[];
}

export interface VerificationFile {
  boards: Record<string, VerificationRecord>;
}

export interface AssembledBoard extends SeedBoard {
  jobCount: number;
  verifiedAt: string;
  listings: ProbedListing[];
}

export interface AtsDelegateDescriptor extends Omit<SeedDescriptor, 'boards'> {
  moduleName: string;
  serviceName: string;
  boards: AssembledBoard[];
}

/** Everything the generator needs to know about one backend. */
interface BackendSpec {
  /** `Site` enum key of the ATS plugin delegated to. */
  siteKey: string;
  label: string;
  servicePkg: string;
  serviceClass: string;
  /** ScraperInputDto field that addresses a board. */
  inputField: 'companySlug' | 'companyUrl';
  /** The id prefix the adapter stamps, which the plugin rewrites. */
  atsIdPrefix(slug: string): string;
  /** Public, human-facing URL of the board. */
  boardUrl(slug: string): string;
  /**
   * Reason the real adapter reports for an HTTP 404 on the board, or null when
   * it degrades to a bare empty result (iCIMS treats a 4xx as an unknown tenant).
   */
  notFoundReason: string | null;
  /** Recorded HTTP responses (keyed by URL without query) + expected mapping. */
  fixture(d: AtsDelegateDescriptor, board: AssembledBoard): BoardFixture;
}

interface BoardFixture {
  responses: Record<string, unknown>;
  expected: Array<{ id: string; title: string }>;
}

/** Deterministic stand-in timestamp for listings recorded without one. */
const FIXED_ISO = '2026-09-24T00:00:00.000Z';

/** Parse the Workday compound slug `{tenant}:{wdNumber}:{site}`. */
export function parseWorkdaySlug(slug: string): { tenant: string; wdNumber: string; site: string } {
  const parts = slug.split(':');
  return { tenant: parts[0], wdNumber: parts[1] || '5', site: parts[2] || 'External' };
}

function workdayHost(slug: string): string {
  const { tenant, wdNumber } = parseWorkdaySlug(slug);
  return `https://${tenant}.wd${wdNumber}.myworkdayjobs.com`;
}

/**
 * Requisition id the recorded detail response carries (and so the id the
 * Workday adapter will read back). Must be unique per posting: a badge such as
 * Intel's "Spotlight Job" in `bulletFields[0]` would collapse every recorded
 * posting onto one id.
 */
export function workdayReqId(listing: ProbedListing): string {
  return workdayRequisitionId(listing.bulletFields, listing.externalPath) ?? listing.id;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function blurb(d: AtsDelegateDescriptor, title: string): string {
  return `${title} at ${d.displayName}.`;
}

export const BACKENDS: Record<string, BackendSpec> = {
  workday: {
    siteKey: 'WORKDAY',
    label: 'Workday',
    servicePkg: '@ever-jobs/source-ats-workday',
    serviceClass: 'WorkdayService',
    inputField: 'companySlug',
    atsIdPrefix: (slug) => `wd-${parseWorkdaySlug(slug).tenant}-`,
    boardUrl: (slug) => `${workdayHost(slug)}/${parseWorkdaySlug(slug).site}`,
    notFoundReason: 'bad_input',
    fixture(d, board) {
      const { tenant, site } = parseWorkdaySlug(board.slug);
      const host = workdayHost(board.slug);
      const searchUrl = `${host}/wday/cxs/${tenant}/${site}/jobs`;
      const responses: Record<string, unknown> = {};
      const expected: Array<{ id: string; title: string }> = [];
      responses[searchUrl] = {
        total: board.listings.length,
        jobPostings: board.listings.map((l) => ({
          title: l.title,
          externalPath: l.externalPath,
          locationsText: l.location,
          postedOn: l.postedOn ?? null,
          bulletFields: l.bulletFields ?? [],
        })),
      };
      for (const l of board.listings) {
        const reqId = workdayReqId(l);
        const p = l.externalPath ?? '';
        responses[`${host}/wday/cxs/${tenant}/${site}${p}`] = {
          jobPostingInfo: {
            title: l.title,
            jobDescription: `<p>${htmlEscape(blurb(d, l.title))}</p>`,
            location: l.location,
            jobReqId: reqId,
            externalUrl: `${host}/${site}${p}`,
            timeType: 'Full time',
          },
          // The ATS's own organisation label, deliberately not the display name:
          // the plugin's re-stamp must be what produces COMPANY_NAME.
          hiringOrganization: { name: tenant },
        };
        expected.push({ id: `${d.key}-${reqId}`, title: l.title });
      }
      return { responses, expected };
    },
  },
  greenhouse: {
    siteKey: 'GREENHOUSE',
    label: 'Greenhouse',
    servicePkg: '@ever-jobs/source-ats-greenhouse',
    serviceClass: 'GreenhouseService',
    inputField: 'companySlug',
    atsIdPrefix: () => 'gh-',
    boardUrl: (slug) => `https://job-boards.greenhouse.io/${slug}`,
    notFoundReason: 'bad_input',
    fixture(d, board) {
      const jobs = board.listings.map((l) => ({
        id: /^\d+$/.test(l.id) ? Number(l.id) : l.id,
        title: l.title,
        updated_at: l.updatedAt ?? FIXED_ISO,
        ...(l.location ? { location: { name: l.location } } : {}),
        absolute_url: `https://job-boards.greenhouse.io/${board.slug}/jobs/${l.id}`,
        content: htmlEscape(`<p>${htmlEscape(blurb(d, l.title))}</p>`),
        departments: l.department ? [{ id: 1, name: l.department }] : [],
        offices: [],
        metadata: [],
        company_name: board.slug,
      }));
      return {
        responses: { [`https://api.greenhouse.io/v1/boards/${board.slug}/jobs`]: { jobs } },
        expected: board.listings.map((l) => ({ id: `${d.key}-${l.id}`, title: l.title })),
      };
    },
  },
  lever: {
    siteKey: 'LEVER',
    label: 'Lever',
    servicePkg: '@ever-jobs/source-ats-lever',
    serviceClass: 'LeverService',
    inputField: 'companySlug',
    atsIdPrefix: () => 'lever-',
    boardUrl: (slug) => `https://jobs.lever.co/${slug}`,
    notFoundReason: 'bad_input',
    fixture(d, board) {
      const postings = board.listings.map((l) => ({
        id: l.id,
        text: l.title,
        categories: {
          ...(l.location ? { location: l.location } : {}),
          ...(l.department ? { team: l.department } : {}),
          commitment: 'Full-time',
        },
        createdAt: Date.parse(l.updatedAt ?? FIXED_ISO),
        hostedUrl: `https://jobs.lever.co/${board.slug}/${l.id}`,
        applyUrl: `https://jobs.lever.co/${board.slug}/${l.id}/apply`,
        descriptionPlain: blurb(d, l.title),
        lists: [],
      }));
      return {
        responses: { [`https://api.lever.co/v0/postings/${board.slug}`]: postings },
        expected: board.listings.map((l) => ({ id: `${d.key}-${l.id}`, title: l.title })),
      };
    },
  },
  ashby: {
    siteKey: 'ASHBY',
    label: 'Ashby',
    servicePkg: '@ever-jobs/source-ats-ashby',
    serviceClass: 'AshbyService',
    inputField: 'companySlug',
    atsIdPrefix: () => 'ashby-',
    boardUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    notFoundReason: 'bad_input',
    fixture(d, board) {
      const jobs = board.listings.map((l) => ({
        id: l.id,
        title: l.title,
        ...(l.location ? { location: l.location } : {}),
        ...(l.department ? { department: l.department, team: l.department } : {}),
        employmentType: 'FullTime',
        isListed: true,
        isRemote: false,
        publishedAt: l.updatedAt ?? FIXED_ISO,
        jobUrl: `https://jobs.ashbyhq.com/${board.slug}/${l.id}`,
        applyUrl: `https://jobs.ashbyhq.com/${board.slug}/${l.id}/application`,
        descriptionPlain: blurb(d, l.title),
      }));
      return {
        responses: { [`https://api.ashbyhq.com/posting-api/job-board/${board.slug}`]: { jobs } },
        expected: board.listings.map((l) => ({ id: `${d.key}-${l.id}`, title: l.title })),
      };
    },
  },
  smartrecruiters: {
    siteKey: 'SMARTRECRUITERS',
    label: 'SmartRecruiters',
    servicePkg: '@ever-jobs/source-ats-smartrecruiters',
    serviceClass: 'SmartRecruitersService',
    inputField: 'companySlug',
    atsIdPrefix: () => 'sr-',
    boardUrl: (slug) => `https://jobs.smartrecruiters.com/${slug}`,
    notFoundReason: 'bad_input',
    fixture(d, board) {
      const content = board.listings.map((l) => ({
        id: l.id,
        name: l.title,
        releasedDate: l.updatedAt ?? FIXED_ISO,
        company: { identifier: board.slug, name: board.slug },
        location: { city: null, region: null, country: null, remote: false, fullLocation: l.location },
        department: { label: l.department },
        typeOfEmployment: { id: 'permanent', label: 'Full-time' },
        ref: `https://jobs.smartrecruiters.com/${board.slug}/${l.id}`,
        jobAd: {
          sections: {
            jobDescription: { title: 'Job Description', text: `<p>${htmlEscape(blurb(d, l.title))}</p>` },
          },
        },
      }));
      return {
        responses: {
          [`https://api.smartrecruiters.com/v1/companies/${board.slug}/postings`]: {
            offset: 0,
            limit: 100,
            totalFound: content.length,
            content,
          },
        },
        expected: board.listings.map((l) => ({ id: `${d.key}-${l.id}`, title: l.title })),
      };
    },
  },
  icims: {
    siteKey: 'ICIMS',
    label: 'iCIMS',
    servicePkg: '@ever-jobs/source-ats-icims',
    serviceClass: 'IcimsService',
    inputField: 'companySlug',
    atsIdPrefix: (slug) => `icims-${slug}-`,
    boardUrl: (slug) => `https://${slug}.icims.com/jobs/search`,
    notFoundReason: null,
    fixture(d, board) {
      const cards = board.listings
        .map((l) => {
          const href = `https://${board.slug}.icims.com/jobs/${l.id}/job`;
          return (
            `<div class="row iCIMS_JobCardItem">` +
            `<div class="col-xs-12 title"><a class="iCIMS_Anchor" href="${href}" title="${l.id} - ${htmlEscape(l.title)}">` +
            `<h3>${htmlEscape(l.title)}</h3></a></div>` +
            `<div class="col-xs-12 description">${htmlEscape(blurb(d, l.title))}</div>` +
            `</div>`
          );
        })
        .join('');
      const html =
        `<html><head><title>Job Listings at ${htmlEscape(board.slug)}</title></head>` +
        `<body><div class="iCIMS_JobsTable">${cards}</div>` +
        `<div class="iCIMS_Paging">Page 1 of 1</div></body></html>`;
      return {
        responses: { [`https://${board.slug}.icims.com/jobs/search`]: html },
        expected: board.listings.map((l) => ({ id: `${d.key}-${l.id}`, title: l.title })),
      };
    },
  },
};

/** Escape a value for a single-quoted TS string literal. */
function sq(s: string): string {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Neutralise comment terminators inside doc-comment prose. */
function safe(s: string): string {
  return String(s).replace(/\*\//g, '* /');
}

/** `Aerospace and defense` -> `aerospace-and-defense`. */
export function tagSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The machine-greppable tag suffix carried in `@SourcePlugin.description`. */
export function tagLine(d: Pick<SeedDescriptor, 'segment' | 'industry'>): string {
  return `Tags: segment=${d.segment}; industry=${tagSlug(d.industry)}.`;
}

function wrap(text: string, width: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function backendOf(d: Pick<AtsDelegateDescriptor, 'boards' | 'key'>): BackendSpec {
  const backend = d.boards[0]?.backend;
  const spec = backend ? BACKENDS[backend] : undefined;
  if (!spec) throw new Error(`${d.key}: unsupported backend ${String(backend)}`);
  return spec;
}

/**
 * Join seed descriptors with the live verification record. Throws when a board
 * was never verified, when a plugin mixes backends, or on a malformed seed.
 */
export function assembleDescriptors(
  seeds: SeedDescriptor[],
  verification: VerificationFile,
  only?: string[],
): AtsDelegateDescriptor[] {
  const wanted = only?.length ? new Set(only) : null;
  const seen = new Set<string>();
  const out: AtsDelegateDescriptor[] = [];
  for (const s of seeds) {
    if (wanted && !wanted.has(s.key)) continue;
    if (!/^[a-z0-9][a-z0-9_]*$/.test(s.key)) throw new Error(`bad key: ${s.key}`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(s.enumKey)) throw new Error(`${s.key}: bad enumKey ${s.enumKey}`);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(s.className)) throw new Error(`${s.key}: bad className ${s.className}`);
    if (seen.has(s.key)) throw new Error(`duplicate key: ${s.key}`);
    seen.add(s.key);
    if (!s.boards?.length) throw new Error(`${s.key}: no boards`);
    const backends = new Set(s.boards.map((b) => b.backend));
    if (backends.size !== 1) throw new Error(`${s.key}: boards mix backends`);
    if (!BACKENDS[s.boards[0].backend]) throw new Error(`${s.key}: unsupported backend ${s.boards[0].backend}`);
    for (const domain of s.companyDomains ?? []) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) || domain.startsWith('www.')) {
        throw new Error(`${s.key}: bad companyDomains entry ${domain}`);
      }
    }
    const boards: AssembledBoard[] = s.boards.map((b) => {
      const rec = verification.boards[`${b.backend}:${b.slug}`];
      if (!rec || rec.status !== 200 || !(rec.jobCount > 0) || !rec.listings?.length) {
        throw new Error(`${s.key}: board ${b.backend}:${b.slug} has no live verification record`);
      }
      return { ...b, jobCount: rec.jobCount, verifiedAt: rec.verifiedAt, listings: rec.listings };
    });
    out.push({
      ...s,
      companyDomains: s.companyDomains ?? [],
      moduleName: `${s.className}Module`,
      serviceName: `${s.className}Service`,
      boards,
    });
  }
  return out;
}

function packageJson(d: AtsDelegateDescriptor): string {
  return (
    JSON.stringify(
      {
        name: `@ever-jobs/source-company-${d.key}`,
        version: '0.0.1',
        private: true,
        main: 'src/index.ts',
        types: 'src/index.ts',
      },
      null,
      2,
    ) + '\n'
  );
}

function tsconfigJson(): string {
  return (
    JSON.stringify(
      {
        extends: '../../../tsconfig.base.json',
        compilerOptions: { outDir: './dist', rootDir: './src' },
        include: ['src/**/*'],
      },
      null,
      2,
    ) + '\n'
  );
}

function indexFile(d: AtsDelegateDescriptor): string {
  return (
    `export { ${d.moduleName} } from './${d.key}.module';\n` +
    `export { ${d.serviceName} } from './${d.key}.service';\n`
  );
}

function moduleFile(d: AtsDelegateDescriptor): string {
  return (
    `import { Module } from '@nestjs/common';\n` +
    `import { ${d.serviceName} } from './${d.key}.service';\n\n` +
    `@Module({ providers: [${d.serviceName}], exports: [${d.serviceName}] })\n` +
    `export class ${d.moduleName} {}\n`
  );
}

function boardLine(b: AssembledBoard, spec: BackendSpec): string[] {
  const label = b.label ? ` (${b.label})` : '';
  return [
    ` *   - \`${b.slug}\`${label} — ${spec.boardUrl(b.slug)}`,
    ` *     verified live ${b.verifiedAt}: ${b.jobCount.toLocaleString('en-US')} open postings.`,
  ];
}

export function serviceFile(d: AtsDelegateDescriptor): string {
  const spec = backendOf(d);
  const doc: string[] = [
    '/**',
    ` * ${safe(d.displayName)} — ${safe(d.industry)} (HQ: ${safe(d.hq)}).`,
    ' *',
    ` * Source (Spec ${d.specNo}): ${spec.label} board${d.boards.length > 1 ? 's' : ''}, scraped in this order:`,
    ...d.boards.flatMap((b) => boardLine(b, spec)),
    ' *',
    ...wrap(
      `The plugin re-implements no parsing. It resolves the registered ${spec.label} ` +
        'source plugin from the PluginRegistry at runtime, delegates each board in turn ' +
        '(sequentially, early-career boards first, each with the remaining resultsWanted ' +
        'budget), then re-stamps the company identity (site, companyName, id prefix) so ' +
        `every ${spec.label} field fix is inherited and no plugin imports a peer. The ` +
        'search term and every other caller input pass through untouched.',
      74,
    ).map((l) => ` * ${l}`),
    ' *',
    ` * ${tagLine(d)}`,
    ' */',
  ];
  const boards = d.boards
    .map(
      (b) =>
        `  { ${spec.inputField}: '${sq(b.slug)}', atsIdPrefix: '${sq(spec.atsIdPrefix(b.slug))}' },`,
    )
    .join('\n');
  const domains = d.companyDomains.map((x) => `'${sq(x)}'`).join(', ');
  const description = `${d.displayName} careers via ${spec.label}. ${tagLine(d)}`;
  const name = sq(d.displayName);
  return `import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  ACTIONABLE_SCRAPE_REASONS,
  classifyScrapeError,
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScrapeDiagnostics,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';

${doc.join('\n')}
const COMPANY_NAME = '${name}';
const ID_PREFIX = '${sq(d.key)}-';

/** Delegated boards, in scrape order. */
const BOARDS: ReadonlyArray<{ readonly ${spec.inputField}: string; readonly atsIdPrefix: string }> = [
${boards}
];

@SourcePlugin({
  site: Site.${d.enumKey},
  name: COMPANY_NAME,
  category: 'company',
  companyDomains: [${domains}],
  description: '${sq(description)}',
})
@Injectable()
export class ${d.serviceName} implements IScraper {
  private readonly logger = new Logger(${d.serviceName}.name);

  constructor(@Optional() private readonly registry?: PluginRegistry) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const backend = this.registry?.getScraper(Site.${spec.siteKey});
    if (!backend) {
      this.logger.error('${spec.label} source plugin is not registered; cannot scrape ${name}');
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', '${spec.label} source plugin is not registered'),
      );
    }

    const wanted = input.resultsWanted;
    const jobs: JobPostDto[] = [];
    const seen = new Set<string>();
    let actionable: ScrapeDiagnostics | undefined;
    let fallback: ScrapeDiagnostics | undefined;

    for (const board of BOARDS) {
      const remaining = wanted == null ? undefined : wanted - jobs.length;
      if (remaining !== undefined && remaining <= 0) break;
      this.logger.log(\`${sq(d.displayName)}: delegating to ${spec.label} (\${board.${spec.inputField}})\`);

      let result: JobResponseDto;
      try {
        result = await backend.scrape({
          ...input,
          ${spec.inputField}: board.${spec.inputField},
          ...(remaining !== undefined ? { resultsWanted: remaining } : {}),
        } as ScraperInputDto);
      } catch (err: unknown) {
        // Adapters resolve rather than throw; classify a regression instead of
        // letting one board sink the fan-out.
        actionable = actionable ?? classifyScrapeError(err);
        continue;
      }

      const diagnostics = result.diagnostics;
      if (diagnostics) {
        if (ACTIONABLE_SCRAPE_REASONS.includes(diagnostics.reason)) {
          actionable = actionable ?? diagnostics;
        } else {
          fallback = fallback ?? diagnostics;
        }
      }

      for (const job of result.jobs ?? []) {
        job.site = Site.${d.enumKey};
        job.companyName = COMPANY_NAME;
        if (job.id?.startsWith(board.atsIdPrefix)) {
          job.id = ID_PREFIX + job.id.slice(board.atsIdPrefix.length);
        }
        const key = job.id ?? job.jobUrl ?? job.title;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        jobs.push(job);
      }
    }

    this.logger.log(\`${sq(d.displayName)}: scraped \${jobs.length} jobs\`);
    // An actionable reason always surfaces (with jobs it reads as partial);
    // a benign one (e.g. empty) only when nothing was found at all.
    const diagnostics = actionable ?? (jobs.length === 0 ? fallback : undefined);
    return new JobResponseDto(jobs, diagnostics);
  }
}
`;
}

export function fixtureFile(d: AtsDelegateDescriptor): string {
  const spec = backendOf(d);
  const responses: Record<string, unknown> = {};
  const expected: Array<{ id: string; title: string }> = [];
  for (const b of d.boards) {
    const fx = spec.fixture(d, b);
    Object.assign(responses, fx.responses);
    expected.push(...fx.expected);
  }
  const fixture = {
    note:
      `Recorded ${spec.label} listings (live verification ${d.boards[0].verifiedAt}, Spec ${d.specNo}); ` +
      'descriptions and detail payloads are minimal stand-ins derived from the listing.',
    backend: d.boards[0].backend,
    boards: d.boards.map((b) => ({
      input: { [spec.inputField]: b.slug },
      atsIdPrefix: spec.atsIdPrefix(b.slug),
    })),
    responses,
    expected,
  };
  return JSON.stringify(fixture, null, 2) + '\n';
}

export function testFile(d: AtsDelegateDescriptor): string {
  const spec = backendOf(d);
  const multi = d.boards.length > 1;
  const reasonAssert = spec.notFoundReason
    ? `      expect(result.diagnostics?.reason).toBe('${spec.notFoundReason}');\n`
    : `      // ${spec.label} treats a 4xx board as an unknown tenant: a bare empty result.\n`;
  const multiBlock = multi
    ? `
  describe('multiple boards', () => {
    it('scrapes the boards in order and spends only the remaining budget', async () => {
      const captured: ScraperInputDto[] = [];
      let call = 0;
      const service = new ${d.serviceName}(
        registryWith(
          fakeBackend((input) => {
            const board = FIXTURE.boards[call++];
            return new JobResponseDto([
              new JobPostDto({ id: board.atsIdPrefix + 'job-' + call, title: 'Role', jobUrl: 'u' + call }),
            ]);
          }, captured),
        ),
      );
      const result = await service.scrape({ siteType: [Site.${d.enumKey}], resultsWanted: 7 } as ScraperInputDto);
      expect(captured.map(boardOf)).toEqual(FIXTURE.boards.map(boardInputOf));
      expect(captured.map((c) => c.resultsWanted)).toEqual(FIXTURE.boards.map((_, i) => 7 - i));
      expect(result.jobs).toHaveLength(FIXTURE.boards.length);
    });

    it('stops once an earlier board has filled resultsWanted', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new ${d.serviceName}(
        registryWith(
          fakeBackend(
            () => new JobResponseDto([new JobPostDto({ id: FIXTURE.boards[0].atsIdPrefix + 'a', title: 'Role', jobUrl: 'u' })]),
            captured,
          ),
        ),
      );
      const result = await service.scrape({ siteType: [Site.${d.enumKey}], resultsWanted: 1 } as ScraperInputDto);
      expect(captured).toHaveLength(1);
      expect(result.jobs).toHaveLength(1);
    });

    it('de-duplicates a posting listed on two boards', async () => {
      const service = new ${d.serviceName}(
        registryWith(
          fakeBackend(
            (input) =>
              new JobResponseDto([
                new JobPostDto({ id: FIXTURE.boards.find((b) => boardInputOf(b) === boardOf(input))!.atsIdPrefix + 'same', title: 'Role', jobUrl: 'u' }),
              ]),
          ),
        ),
      );
      const result = await service.scrape({ siteType: [Site.${d.enumKey}] } as ScraperInputDto);
      expect(result.jobs.map((j) => j.id)).toEqual([ID_PREFIX + 'same']);
    });

    it('keeps a healthy board\\'s jobs and surfaces the failing board\\'s reason', async () => {
      let call = 0;
      const service = new ${d.serviceName}(
        registryWith(
          fakeBackend(() =>
            call++ === 0
              ? new JobResponseDto([], new ScrapeDiagnostics('fetch_error', 'HTTP 503'))
              : new JobResponseDto([new JobPostDto({ id: FIXTURE.boards[1].atsIdPrefix + 'b', title: 'Role', jobUrl: 'u' })]),
          ),
        ),
      );
      const result = await service.scrape({ siteType: [Site.${d.enumKey}] } as ScraperInputDto);
      expect(result.jobs.map((j) => j.id)).toEqual([ID_PREFIX + 'b']);
      expect(result.diagnostics?.reason).toBe('fetch_error');
    });
  });
`
    : '';
  return `import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import {
  IScraper,
  JobPostDto,
  JobResponseDto,
  ScrapeDiagnostics,
  ScraperInputDto,
  Site,
} from '@ever-jobs/models';
import { PluginRegistry, SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { ${spec.serviceClass} } from '${spec.servicePkg}';

const mockGet = jest.fn();
const mockPost = jest.fn();
jest.mock('@ever-jobs/common', () => {
  const actual = jest.requireActual('@ever-jobs/common');
  return {
    ...actual,
    createHttpClient: jest.fn(() => ({ get: mockGet, post: mockPost, setHeaders: jest.fn() })),
    // The recorded boards are single pages; never sleep between pages in a unit test.
    randomSleep: jest.fn(async () => undefined),
  };
});

import { ${d.moduleName}, ${d.serviceName} } from '../src';

interface Fixture {
  backend: string;
  boards: Array<{ input: Record<string, string>; atsIdPrefix: string }>;
  responses: Record<string, unknown>;
  expected: Array<{ id: string; title: string }>;
}

const FIXTURE: Fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', '${d.key}-boards.json'), 'utf8'),
);
const COMPANY_NAME = '${sq(d.displayName)}';
const ID_PREFIX = '${sq(d.key)}-';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Serve the recorded responses by URL (query ignored); anything else is a 404. */
function serve(url: string): Promise<{ data: unknown }> {
  const key = String(url).split('?')[0];
  if (Object.prototype.hasOwnProperty.call(FIXTURE.responses, key)) {
    return Promise.resolve({ data: clone(FIXTURE.responses[key]) });
  }
  return notFound(url);
}

function notFound(url: string): Promise<never> {
  const err: any = new Error(\`Request failed with status code 404 (\${url})\`);
  err.response = { status: 404 };
  return Promise.reject(err);
}

function registryWith(scraper: IScraper = new ${spec.serviceClass}()): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register({ site: Site.${spec.siteKey}, name: '${spec.label}', category: 'ats', isAts: true }, scraper);
  return registry;
}

function fakeBackend(
  impl: (input: ScraperInputDto) => JobResponseDto,
  captured: ScraperInputDto[] = [],
): IScraper {
  return {
    scrape: async (input) => {
      captured.push(input);
      return impl(input);
    },
  };
}

const boardOf = (input: ScraperInputDto): string | undefined => (input as any).${spec.inputField};
const boardInputOf = (b: Fixture['boards'][number]): string => b.input.${spec.inputField};

describe('${d.serviceName} — ${spec.label} delegation (Spec ${d.specNo})', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockImplementation(serve);
    mockPost.mockImplementation(serve);
  });

  describe('registration', () => {
    it('resolves through ${d.moduleName} via NestJS DI', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [${d.moduleName}] }).compile();
      expect(moduleRef.get(${d.serviceName})).toBeInstanceOf(${d.serviceName});
      await moduleRef.close();
    });

    it('exports Site.${d.enumKey} = "${d.key}"', () => {
      expect(Site.${d.enumKey}).toBe('${d.key}');
    });

    it('declares a tagged company plugin with its domains', () => {
      const meta = Reflect.getMetadata(SOURCE_PLUGIN_METADATA, ${d.serviceName});
      expect(meta.site).toBe(Site.${d.enumKey});
      expect(meta.category).toBe('company');
      expect(meta.isAts).toBeFalsy();
      expect(meta.companyDomains).toEqual(${JSON.stringify(d.companyDomains).replace(/"/g, "'")});
      expect(meta.description).toContain('segment=${d.segment}');
    });
  });

  describe('recorded board${multi ? 's' : ''} (real ${spec.label} adapter, mocked HTTP)', () => {
    it('maps every recorded posting and re-stamps the company identity', async () => {
      const service = new ${d.serviceName}(registryWith());
      const result = await service.scrape({ siteType: [Site.${d.enumKey}], resultsWanted: 100 } as ScraperInputDto);
      expect(result.diagnostics).toBeUndefined();
      expect(result.jobs.map((j) => j.id)).toEqual(FIXTURE.expected.map((e) => e.id));
      expect(result.jobs.map((j) => j.title)).toEqual(FIXTURE.expected.map((e) => e.title));
      for (const job of result.jobs) {
        expect(job.site).toBe(Site.${d.enumKey});
        expect(job.companyName).toBe(COMPANY_NAME);
        expect(job.id?.startsWith(ID_PREFIX)).toBe(true);
        expect(job.jobUrl).toBeTruthy();
      }
    });

    it('only requests the recorded board URLs', async () => {
      const service = new ${d.serviceName}(registryWith());
      await service.scrape({ siteType: [Site.${d.enumKey}] } as ScraperInputDto);
      const urls = [...mockGet.mock.calls, ...mockPost.mock.calls].map((c) => String(c[0]).split('?')[0]);
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        expect(Object.keys(FIXTURE.responses)).toContain(url);
      }
    });

    it('honours resultsWanted=1', async () => {
      const service = new ${d.serviceName}(registryWith());
      const result = await service.scrape({ siteType: [Site.${d.enumKey}], resultsWanted: 1 } as ScraperInputDto);
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].id).toBe(FIXTURE.expected[0].id);
    });

    it('resolves with an empty result when the board is gone (HTTP 404)', async () => {
      mockGet.mockImplementation(notFound);
      mockPost.mockImplementation(notFound);
      const service = new ${d.serviceName}(registryWith());
      const result = await service.scrape({ siteType: [Site.${d.enumKey}] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
${reasonAssert}    });
  });

  describe('delegation contract', () => {
    it('forwards the board and the caller input untouched', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new ${d.serviceName}(
        registryWith(
          fakeBackend(
            () => new JobResponseDto([new JobPostDto({ id: FIXTURE.boards[0].atsIdPrefix + 'x1', title: 'Role', jobUrl: 'u' })]),
            captured,
          ),
        ),
      );
      const result = await service.scrape({
        siteType: [Site.${d.enumKey}],
        searchTerm: 'software engineer intern',
        location: 'New York',
        resultsWanted: 1,
      } as ScraperInputDto);
      expect(captured).toHaveLength(1);
      expect(boardOf(captured[0])).toBe(boardInputOf(FIXTURE.boards[0]));
      expect(captured[0].searchTerm).toBe('software engineer intern');
      expect(captured[0].location).toBe('New York');
      expect(captured[0].resultsWanted).toBe(1);
      expect(result.jobs[0].id).toBe(ID_PREFIX + 'x1');
      expect(result.jobs[0].site).toBe(Site.${d.enumKey});
      expect(result.jobs[0].companyName).toBe(COMPANY_NAME);
    });

    it('passes an absent resultsWanted through as absent', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new ${d.serviceName}(registryWith(fakeBackend(() => new JobResponseDto([]), captured)));
      await service.scrape({ siteType: [Site.${d.enumKey}] } as ScraperInputDto);
      expect(captured.length).toBeGreaterThan(0);
      expect(captured[0].resultsWanted).toBeUndefined();
    });

    it('rewrites only the leading ATS id prefix', async () => {
      const prefix = FIXTURE.boards[0].atsIdPrefix;
      const service = new ${d.serviceName}(
        registryWith(
          fakeBackend(() => new JobResponseDto([new JobPostDto({ id: prefix + prefix + '7', title: 'T', jobUrl: 'u' })])),
        ),
      );
      const result = await service.scrape({ siteType: [Site.${d.enumKey}], resultsWanted: 1 } as ScraperInputDto);
      expect(result.jobs[0].id).toBe(ID_PREFIX + prefix + '7');
    });

    it('makes no request when resultsWanted is 0', async () => {
      const captured: ScraperInputDto[] = [];
      const service = new ${d.serviceName}(registryWith(fakeBackend(() => new JobResponseDto([]), captured)));
      const result = await service.scrape({ siteType: [Site.${d.enumKey}], resultsWanted: 0 } as ScraperInputDto);
      expect(captured).toHaveLength(0);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('resilience', () => {
    it('reports not_registered when no registry is injected', async () => {
      const result = await new ${d.serviceName}().scrape({ siteType: [Site.${d.enumKey}] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('not_registered');
      expect(result.diagnostics?.detail).toContain('${spec.label}');
    });

    it('reports not_registered when ${spec.label} is missing from the registry', async () => {
      const result = await new ${d.serviceName}(new PluginRegistry()).scrape({
        siteType: [Site.${d.enumKey}],
      } as ScraperInputDto);
      expect(result.diagnostics?.reason).toBe('not_registered');
    });

    it('surfaces the backend diagnostic of a failed board', async () => {
      const service = new ${d.serviceName}(
        registryWith(fakeBackend(() => new JobResponseDto([], new ScrapeDiagnostics('fetch_error', 'HTTP 503')))),
      );
      const result = await service.scrape({ siteType: [Site.${d.enumKey}] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics?.reason).toBe('fetch_error');
    });

    it('passes a benign empty-board reason through only when nothing was found', async () => {
      const service = new ${d.serviceName}(
        registryWith(fakeBackend(() => new JobResponseDto([], new ScrapeDiagnostics('empty', 'no postings')))),
      );
      const result = await service.scrape({ siteType: [Site.${d.enumKey}] } as ScraperInputDto);
      expect(result.diagnostics?.reason).toBe('empty');
    });

    it('classifies a thrown backend error instead of rejecting', async () => {
      const service = new ${d.serviceName}(
        registryWith({
          scrape: async () => {
            throw new Error('socket hang up');
          },
        }),
      );
      const result = await service.scrape({ siteType: [Site.${d.enumKey}] } as ScraperInputDto);
      expect(result.jobs).toEqual([]);
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics?.reason).not.toBe('ok');
    });
  });
${multiBlock}});
`;
}

function writeFileSafe(abs: string, content: string): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Emit one plugin package. Never touches `.specify/` or the shared wiring files. */
export function scaffoldOne(repoRoot: string, d: AtsDelegateDescriptor): string[] {
  const pkgDir = path.join(repoRoot, 'packages', 'plugins', `source-company-${d.key}`);
  const files: Array<[string, string]> = [
    [path.join(pkgDir, 'package.json'), packageJson(d)],
    [path.join(pkgDir, 'tsconfig.json'), tsconfigJson()],
    [path.join(pkgDir, 'src', 'index.ts'), indexFile(d)],
    [path.join(pkgDir, 'src', `${d.key}.module.ts`), moduleFile(d)],
    [path.join(pkgDir, 'src', `${d.key}.service.ts`), serviceFile(d)],
    [path.join(pkgDir, '__tests__', `${d.key}.service.spec.ts`), testFile(d)],
    [path.join(pkgDir, '__tests__', 'fixtures', `${d.key}-boards.json`), fixtureFile(d)],
  ];
  for (const [abs, content] of files) writeFileSafe(abs, content);
  return files.map(([abs]) => abs);
}

/** Markdown table of every board of a batch, for the batch spec. */
export function renderVerificationTable(descriptors: AtsDelegateDescriptor[]): string {
  const rows = [
    '| Plugin (`Site`) | Company | Platform | Board (slug / tenant:wd:site) | Verified | Jobs seen |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const d of descriptors) {
    const spec = backendOf(d);
    for (const b of d.boards) {
      const label = b.label ? ` (${b.label})` : '';
      rows.push(
        `| \`${d.key}\` | ${d.displayName} | ${spec.label} | \`${b.slug}\`${label} | ${b.verifiedAt} | ${b.jobCount.toLocaleString('en-US')} |`,
      );
    }
  }
  return rows.join('\n') + '\n';
}

function main(): void {
  const [seedPath, verificationPath, onlyArg] = process.argv.slice(2);
  if (!seedPath || !verificationPath) {
    throw new Error(
      'usage: scaffold-ats-delegate-company-source.ts <seeds.json> <verification.json> [key,key,...]',
    );
  }
  const repoRoot = process.cwd();
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(repoRoot, p));
  const seeds: SeedDescriptor[] = JSON.parse(fs.readFileSync(abs(seedPath), 'utf8'));
  const verification: VerificationFile = JSON.parse(fs.readFileSync(abs(verificationPath), 'utf8'));
  const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const descriptors = assembleDescriptors(seeds, verification, only);
  for (const d of descriptors) scaffoldOne(repoRoot, d);
  // eslint-disable-next-line no-console
  console.log(`Scaffolded ${descriptors.length} ATS-delegating company-source plugin(s).`);
}

if (require.main === module) {
  main();
}
