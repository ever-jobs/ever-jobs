/**
 * probe-ats-delegate-company-source.ts — Spec 1735
 *
 * Polite, serial **verification** helper for company-direct source candidates
 * whose careers board is hosted on an ATS that Ever Jobs already has an adapter
 * for (Workday, Greenhouse, Lever, Ashby, SmartRecruiters, and the HTML boards
 * of Avature and iCIMS, where the probe counts distinct job links on the first
 * listing page). A verified board is
 * later turned into a thin registry-delegating `source-company-<slug>` plugin
 * by `scripts/scaffold-ats-delegate-company-source.ts`.
 *
 * Unlike the older per-backend probes (which fan out at concurrency 16 over
 * hundreds of guessed slugs), this probe verifies a short, hand-curated list of
 * large employers and quant/trading firms, so it is deliberately **polite**:
 *
 *   - strictly serial: one request in flight, process-wide;
 *   - at least `MIN_INTERVAL_MS` (1.1 s) between request starts, i.e. < 1 req/s;
 *   - at most `MAX_VARIANTS_PER_COMPANY` (3) requests per company — one per
 *     candidate `{backend, slug}` variant, stopping at the first that verifies;
 *   - listing endpoint only (a Workday search page of 20, a Greenhouse board
 *     without `content`) — never a detail page;
 *   - an honest, identifying User-Agent (`PROBE_USER_AGENT`), no browser
 *     impersonation, no cookies, no bot-wall handling of any kind.
 *
 * Input: a JSON array of `ProbeCandidate` (`key`, `displayName`, `variants`,
 * plus any descriptive fields, which are carried through untouched).
 * Output: a `ProbeReport` — `verified[]` (the winning variant, the live job
 * count, up to 3 recorded listings for the test fixture, the verification
 * date and every attempt) and `rejected[]` (all attempts failed).
 *
 * Network I/O is isolated in `probeCandidates`; request building, payload
 * gating and listing extraction are pure and unit-tested
 * (`scripts/__tests__/probe-ats-delegate-company-source.spec.ts`).
 *
 * Usage (via ts-node):
 *   ts-node --project tsconfig.base.json -r tsconfig-paths/register \
 *     scripts/probe-ats-delegate-company-source.ts candidates.json report.json
 *
 * This script NEVER mutates the repository beyond writing the report file.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

/** ATS backends a company plugin may delegate to. */
export type DelegateBackend =
  | 'workday'
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'avature'
  | 'icims';

export const DELEGATE_BACKENDS: readonly DelegateBackend[] = [
  'workday',
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
  'avature',
  'icims',
];

/** Backends whose listing endpoint answers HTML rather than JSON. */
export const HTML_BACKENDS: readonly DelegateBackend[] = ['avature', 'icims'];

/** Hard cap on live requests spent verifying one company. */
export const MAX_VARIANTS_PER_COMPANY = 3;
/** Minimum gap between two request starts, process-wide (< 1 req/s). */
export const MIN_INTERVAL_MS = 1100;
/** Minimum live postings for a board to count as verified. */
export const MIN_JOBS = 1;
/** Listings recorded per verified board (seeds the unit-test fixture). */
export const RECORDED_LISTINGS = 3;
/** Workday search page size used for the single verification request. */
export const WORKDAY_PROBE_PAGE_SIZE = 20;

/** Honest, identifying UA — no browser impersonation. */
export const PROBE_USER_AGENT =
  'EverJobs-SourceVerifier/1.0 (+https://github.com/ever-co/ever-jobs; ' +
  'one-off careers-listing check, max 1 req/s)';

export interface CandidateVariant {
  backend: DelegateBackend;
  /**
   * Backend board identifier. Workday uses the adapter's compound slug
   * `{tenant}:{wdNumber}:{site}` (e.g. `salesforce:12:External_Career_Site`);
   * Avature uses the portal base URL (`https://careers.example.com`, passed to
   * the adapter as `companyUrl`); iCIMS uses the board subdomain
   * (`careers-acme`); every other backend uses its bare board slug.
   */
  slug: string;
}

export interface ProbeCandidate {
  /** Plugin slug = `Site` enum value, e.g. `salesforce`. */
  key: string;
  displayName: string;
  variants: CandidateVariant[];
  [extra: string]: unknown;
}

export interface ProbedListing {
  id: string;
  title: string;
  location: string | null;
  department: string | null;
  updatedAt: string | null;
  /** Workday only: the detail path, e.g. `/job/Austin-TX/SWE_R-1`. */
  externalPath?: string | null;
  /** Workday only: the relative `postedOn` label. */
  postedOn?: string | null;
  /** Workday only: bullet fields (usually the requisition id first). */
  bulletFields?: string[] | null;
}

export interface ProbeAttempt {
  backend: DelegateBackend;
  slug: string;
  url: string;
  status: number | null;
  outcome: 'verified' | 'empty' | 'http_error' | 'network_error' | 'bad_payload' | 'skipped';
  jobCount: number;
}

export interface VerifiedCompany {
  key: string;
  displayName: string;
  backend: DelegateBackend;
  companySlug: string;
  jobCount: number;
  listings: ProbedListing[];
  verifiedAt: string;
  attempts: ProbeAttempt[];
}

export interface RejectedCompany {
  key: string;
  displayName: string;
  attempts: ProbeAttempt[];
}

export interface ProbeReport {
  generatedAt: string;
  userAgent: string;
  minIntervalMs: number;
  requests: number;
  verified: VerifiedCompany[];
  rejected: RejectedCompany[];
}

export interface ProbeRequest {
  method: 'GET' | 'POST';
  url: string;
  body?: string;
}

export interface WorkdaySlugParts {
  tenant: string;
  wdNumber: string;
  site: string;
}

/**
 * Parse the Workday compound slug `{tenant}:{wdNumber}:{site}`. Mirrors the
 * adapter's own defaults (`wd5`, `External`) so a verified slug means exactly
 * what the adapter will request.
 */
export function parseWorkdaySlug(slug: string): WorkdaySlugParts {
  const parts = slug.split(':');
  return {
    tenant: parts[0],
    wdNumber: parts[1] || '5',
    site: parts[2] || 'External',
  };
}

/** Build the single listing request that verifies one variant. */
export function buildProbeRequest(variant: CandidateVariant): ProbeRequest {
  const slug = variant.slug.trim();
  switch (variant.backend) {
    case 'workday': {
      const { tenant, wdNumber, site } = parseWorkdaySlug(slug);
      return {
        method: 'POST',
        url: `https://${tenant}.wd${wdNumber}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
        body: JSON.stringify({
          appliedFacets: {},
          limit: WORKDAY_PROBE_PAGE_SIZE,
          offset: 0,
          searchText: '',
        }),
      };
    }
    case 'greenhouse':
      // Same host as the Greenhouse adapter; no `content=true` — titles only.
      return {
        method: 'GET',
        url: `https://api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
      };
    case 'lever':
      return {
        method: 'GET',
        url: `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
      };
    case 'ashby':
      return {
        method: 'GET',
        url: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
      };
    case 'smartrecruiters':
      return {
        method: 'GET',
        url: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`,
      };
    case 'avature': {
      // First search page, exactly as the Avature adapter paginates it.
      const base = slug.replace(/\/+$/, '');
      return {
        method: 'GET',
        url: `${base}/careers/SearchJobs/?jobOffset=0&jobRecordsPerPage=12`,
      };
    }
    case 'icims':
      // First embeddable board page, exactly as the iCIMS adapter requests it.
      return {
        method: 'GET',
        url: `https://${encodeURIComponent(slug)}.icims.com/jobs/search?ss=1&in_iframe=1`,
      };
    default: {
      const never: never = variant.backend;
      throw new Error(`unsupported backend: ${String(never)}`);
    }
  }
}

/**
 * The requisition id of a Workday search row. `bulletFields` mixes the id with
 * tenant-specific badges ("Spotlight Job", "Exempt", a location, "Posting End
 * Date: 09/30/2026"), so the id is the first bullet that is a single token
 * containing a digit; failing that, the detail path's trailing `_<id>` segment.
 */
export function workdayRequisitionId(
  bulletFields: ReadonlyArray<string> | null | undefined,
  externalPath: string | null | undefined,
): string | null {
  for (const bullet of bulletFields ?? []) {
    const token = String(bullet).trim();
    if (/^[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*$/.test(token)) return token;
  }
  const tail = (externalPath ?? '').split('_').pop()?.replace(/[^A-Za-z0-9-]/g, '') ?? '';
  return externalPath && externalPath.includes('_') && tail ? tail : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s : null;
}

function isoOrNull(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(v).toISOString();
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

/** The raw posting array of a listing payload, per backend. */
function rawPostings(backend: DelegateBackend, payload: unknown): any[] {
  const p = (payload && typeof payload === 'object' ? payload : {}) as any;
  switch (backend) {
    case 'workday':
      return asArray(p.jobPostings);
    case 'greenhouse':
      return asArray(p.jobs);
    case 'lever':
      return asArray(payload);
    case 'ashby':
      return asArray(p.jobs);
    case 'smartrecruiters':
      return asArray(p.content);
    case 'avature':
    case 'icims':
      return htmlPostings(backend, payload);
    default:
      return [];
  }
}

/** Decode the handful of entities that appear in anchor text. */
function decodeText(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Distinct job links on an HTML listing page: Avature `/JobDetail/<slug>/<id>`
 * anchors, iCIMS `/jobs/<id>/<slug>/job` anchors. Anchor text becomes the
 * title; Apply-style decoys and empty anchors are skipped.
 */
function htmlPostings(backend: DelegateBackend, payload: unknown): any[] {
  if (typeof payload !== 'string') return [];
  const linkRe =
    backend === 'avature'
      ? /<a\b[^>]*href="([^"]*\/JobDetail\/[^"]*?\/(\d+))[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
      : /<a\b[^>]*href="([^"]*\/jobs\/(\d+)\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const decoys = new Set(['', 'apply', 'apply now', 'apply online', 'learn more', 'view job']);
  const byId = new Map<string, any>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(payload)) !== null) {
    const id = m[2];
    const title = decodeText(m[3]).replace(/\s+/g, ' ').trim();
    if (decoys.has(title.toLowerCase())) continue;
    if (!byId.has(id)) byId.set(id, { id, title, href: m[1] });
  }
  return [...byId.values()];
}

/**
 * Live job count. Prefers the backend's own total (`total` on Workday,
 * `meta.total` on Greenhouse, `totalFound` on SmartRecruiters) — the probe
 * reads one page only — and falls back to the page length.
 */
export function countJobs(backend: DelegateBackend, payload: unknown): number {
  const p = (payload && typeof payload === 'object' ? payload : {}) as any;
  const page = rawPostings(backend, payload).length;
  let total: unknown = null;
  if (backend === 'workday') total = p.total;
  if (backend === 'greenhouse') total = p.meta?.total;
  if (backend === 'smartrecruiters') total = p.totalFound;
  return typeof total === 'number' && total > page ? total : page;
}

/** Normalise up to `limit` postings into the recorded-listing shape. */
export function extractListings(
  backend: DelegateBackend,
  payload: unknown,
  limit: number = RECORDED_LISTINGS,
): ProbedListing[] {
  const out: ProbedListing[] = [];
  for (const j of rawPostings(backend, payload)) {
    if (out.length >= limit) break;
    if (!j || typeof j !== 'object') continue;
    let listing: ProbedListing | null = null;
    switch (backend) {
      case 'workday': {
        const title = str(j.title);
        if (!title) break;
        const bullets = asArray(j.bulletFields).map((b) => String(b));
        const externalPath = str(j.externalPath);
        listing = {
          id: workdayRequisitionId(bullets, externalPath) ?? externalPath ?? title,
          title,
          location: str(j.locationsText),
          department: null,
          updatedAt: null,
          externalPath,
          postedOn: str(j.postedOn),
          bulletFields: bullets.length ? bullets : null,
        };
        break;
      }
      case 'greenhouse': {
        const title = str(j.title);
        if (!title) break;
        listing = {
          id: String(j.id ?? ''),
          title,
          location: str(j.location?.name),
          department: str(asArray(j.departments)[0]?.name),
          updatedAt: isoOrNull(j.updated_at),
        };
        break;
      }
      case 'lever': {
        const title = str(j.text);
        if (!title) break;
        listing = {
          id: String(j.id ?? ''),
          title,
          location: str(j.categories?.location),
          department: str(j.categories?.team ?? j.categories?.department),
          updatedAt: isoOrNull(j.createdAt),
        };
        break;
      }
      case 'ashby': {
        const title = str(j.title);
        if (!title) break;
        listing = {
          id: String(j.id ?? ''),
          title,
          location: str(j.location),
          department: str(j.department ?? j.team),
          updatedAt: isoOrNull(j.publishedAt),
        };
        break;
      }
      case 'avature':
      case 'icims': {
        const title = str(j.title);
        if (!title) break;
        listing = {
          id: String(j.id),
          title,
          location: null,
          department: null,
          updatedAt: null,
          externalPath: str(j.href),
        };
        break;
      }
      case 'smartrecruiters': {
        const title = str(j.name);
        if (!title) break;
        listing = {
          id: String(j.id ?? ''),
          title,
          location: str(j.location?.fullLocation ?? j.location?.city),
          department: str(j.department?.label),
          updatedAt: isoOrNull(j.releasedDate),
        };
        break;
      }
    }
    if (listing) out.push(listing);
  }
  return out;
}

/**
 * Pure gate: a variant verifies when its listing payload carries at least
 * `minJobs` title-bearing postings.
 */
export function gateVariant(
  backend: DelegateBackend,
  payload: unknown,
  minJobs: number = MIN_JOBS,
): { ok: boolean; jobCount: number; listings: ProbedListing[] } {
  const titled = extractListings(backend, payload, Number.MAX_SAFE_INTEGER);
  if (titled.length < minJobs) {
    return { ok: false, jobCount: titled.length, listings: [] };
  }
  return {
    ok: true,
    jobCount: countJobs(backend, payload),
    listings: titled.slice(0, RECORDED_LISTINGS),
  };
}

/** The variants a company may spend requests on (deduped, capped at 3). */
export function plannedVariants(candidate: ProbeCandidate): CandidateVariant[] {
  const seen = new Set<string>();
  const out: CandidateVariant[] = [];
  for (const v of candidate.variants ?? []) {
    if (!v || !DELEGATE_BACKENDS.includes(v.backend) || !String(v.slug ?? '').trim()) {
      continue;
    }
    const key = `${v.backend}:${v.slug.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ backend: v.backend, slug: v.slug.trim() });
    if (out.length >= MAX_VARIANTS_PER_COMPANY) break;
  }
  return out;
}

interface HttpResult {
  status: number | null;
  /** Parsed JSON, or the raw body for HTML backends; null on failure. */
  json: unknown;
  error?: string;
}

function send(req: ProbeRequest, timeoutMs: number, html = false): Promise<HttpResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      Accept: html ? 'text/html' : 'application/json',
      'User-Agent': PROBE_USER_AGENT,
    };
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(req.body));
    }
    const r = https.request(
      req.url,
      { method: req.method, headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const status = res.statusCode ?? null;
          if (status !== 200) {
            resolve({ status, json: null });
            return;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          if (html) {
            resolve({ status, json: text });
            return;
          }
          try {
            resolve({ status, json: JSON.parse(text) });
          } catch {
            resolve({ status, json: null, error: 'invalid JSON' });
          }
        });
      },
    );
    r.on('error', (e) => resolve({ status: null, json: null, error: e.message }));
    r.on('timeout', () => {
      r.destroy(new Error('timeout'));
    });
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

/** Process-wide pacer: resolves once `MIN_INTERVAL_MS` has passed since the last start. */
export class SerialPacer {
  private last = 0;

  constructor(
    private readonly minIntervalMs: number = MIN_INTERVAL_MS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  async wait(): Promise<void> {
    const gap = this.last + this.minIntervalMs - this.now();
    if (this.last > 0 && gap > 0) await this.sleep(gap);
    this.last = this.now();
  }
}

/** Verify every candidate serially; never more than 3 requests per company. */
export async function probeCandidates(
  candidates: ProbeCandidate[],
  options: {
    timeoutMs?: number;
    today?: string;
    pacer?: SerialPacer;
    transport?: (req: ProbeRequest, timeoutMs: number, html: boolean) => Promise<HttpResult>;
    log?: (line: string) => void;
  } = {},
): Promise<ProbeReport> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const pacer = options.pacer ?? new SerialPacer();
  const transport = options.transport ?? send;
  const log = options.log ?? (() => undefined);
  const report: ProbeReport = {
    generatedAt: new Date().toISOString(),
    userAgent: PROBE_USER_AGENT,
    minIntervalMs: MIN_INTERVAL_MS,
    requests: 0,
    verified: [],
    rejected: [],
  };

  for (const candidate of candidates) {
    const attempts: ProbeAttempt[] = [];
    let winner: VerifiedCompany | null = null;
    for (const variant of plannedVariants(candidate)) {
      const req = buildProbeRequest(variant);
      await pacer.wait();
      report.requests++;
      const res = await transport(req, timeoutMs, HTML_BACKENDS.includes(variant.backend));
      let outcome: ProbeAttempt['outcome'];
      let jobCount = 0;
      if (res.status === null) {
        outcome = 'network_error';
      } else if (res.status !== 200) {
        outcome = 'http_error';
      } else if (res.json === null) {
        outcome = 'bad_payload';
      } else {
        const gate = gateVariant(variant.backend, res.json);
        jobCount = gate.jobCount;
        outcome = gate.ok ? 'verified' : 'empty';
        if (gate.ok) {
          winner = {
            key: candidate.key,
            displayName: candidate.displayName,
            backend: variant.backend,
            companySlug: variant.slug,
            jobCount: gate.jobCount,
            listings: gate.listings,
            verifiedAt: today,
            attempts,
          };
        }
      }
      attempts.push({
        backend: variant.backend,
        slug: variant.slug,
        url: req.url,
        status: res.status,
        outcome,
        jobCount,
      });
      log(
        `  ${outcome === 'verified' ? 'OK ' : '-- '} ${candidate.key} ${variant.backend}:${variant.slug} ` +
          `-> ${res.status ?? res.error ?? 'n/a'} (${jobCount} jobs)`,
      );
      if (winner) break;
    }
    if (winner) report.verified.push(winner);
    else report.rejected.push({ key: candidate.key, displayName: candidate.displayName, attempts });
  }
  return report;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    throw new Error('usage: probe-ats-delegate-company-source.ts <candidates.json> <report.json>');
  }
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(process.cwd(), p));
  const candidates: ProbeCandidate[] = JSON.parse(fs.readFileSync(abs(inputPath), 'utf8'));
  // eslint-disable-next-line no-console
  const log = (line: string) => console.log(line);
  log(`Verifying ${candidates.length} candidate(s) serially, >= ${MIN_INTERVAL_MS} ms apart…`);
  const report = await probeCandidates(candidates, { log });
  fs.writeFileSync(abs(outputPath), JSON.stringify(report, null, 2) + '\n');
  log(
    `Done: ${report.verified.length} verified, ${report.rejected.length} rejected, ` +
      `${report.requests} request(s) -> ${outputPath}`,
  );
}

if (require.main === module) {
  void main();
}
