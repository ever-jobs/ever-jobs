/**
 * Doc-lint — verifies that the `docs/` and `.specify/` trees stay coherent
 * across scheduled runs. Implementation of Spec 002 §7.1.
 *
 * Five checks:
 *   1. Internal markdown links resolve to existing files.
 *   2. Every doc under `docs/` and `.specify/` is reachable from `docs/index.md`
 *      (with a small allow-list for log/questions/templates/constitution).
 *   3. `docs/log.md` entries are unique by `date#run-number`.
 *   4. `docs/log.md` entries are ordered newest-first.
 *   5. Every `spec.md` / `plan.md` / `tasks.md` under `.specify/specs/`
 *      starts with an H1 and a metadata table.
 *   6. (when `.specify/ranges.json` exists) the reserved fork bands are
 *      pairwise non-overlapping, and every spec number falls inside some
 *      registered band — so no fork mints a number outside a reserved lane.
 *
 * Zero runtime deps — small regex parser. See Q-011 in `docs/questions.md`
 * for the trade-off vs `remark-parse` + `unified`.
 */

import { promises as fs } from 'fs';
import * as path from 'path';

import {
  extractSpecNumber,
  findOverlaps,
  loadRanges,
  rangeForNumber,
} from './spec-ranges';

export interface BrokenLink {
  from: string;
  to: string;
}

export interface DocLintResult {
  brokenLinks: BrokenLink[];
  unindexedDocs: string[];
  duplicateLogEntries: string[];
  outOfOrderLogEntries: string[];
  missingFrontmatter: string[];
  overlappingRanges: string[];
  outOfBandSpecs: string[];
  ok: boolean;
}

interface ParsedLink {
  href: string;
  line: number;
}

interface ScannedDoc {
  absPath: string;
  relPath: string;
  body: string;
  links: ParsedLink[];
}

interface LogEntry {
  line: number;
  date: string;
  runNumber: number | null;
  raw: string;
}

const SCAN_ROOTS = ['docs', '.specify'] as const;

const INDEX_EXEMPT = new Set([
  'docs/index.md',
  'docs/log.md',
  'docs/questions.md',
  '.specify/README.md',
  '.specify/memory/constitution.md',
]);

const TEMPLATE_PREFIX = '.specify/templates/';

const INLINE_LINK_RE = /\[(?:[^\]\\]|\\.)*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const INLINE_CODE_RE = /`[^`]+`/g;
const FENCE_RE = /^(```|~~~)/;
// Two-pass header parser: first try to capture the run number, then fall
// back to a date-only header. A single combined regex with an optional
// run-number group is unreliable because the lazy `.*?` always succeeds
// with the optional group skipped — turning every header into a
// "date-only" record (the bug fixed in run #11).
const LOG_HEADER_WITH_RUN_RE =
  /^##\s+(\d{4}-\d{2}-\d{2})\b[^\n]*?\brun\s*#?(\d+)/i;
const LOG_HEADER_DATE_ONLY_RE = /^##\s+(\d{4}-\d{2}-\d{2})\b/;
// Frontmatter check applies to `spec.md` + `plan.md` only (Spec 002 §FR-7).
// `tasks.md` is a list of work items and intentionally has no metadata
// table — see the `.specify/templates/tasks.template.md` shape.
const SPEC_FRONTMATTER_RE = /^\.specify\/specs\/[0-9a-z][0-9a-z\-]*\/(spec|plan)\.md$/;
const TABLE_HEADER_RE = /^\s*\|.+\|\s*$/;
const TABLE_DIVIDER_RE = /^\s*\|[\s:|-]+\|\s*$/;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function isExternal(href: string): boolean {
  return /^(https?:|mailto:|ftp:|tel:|data:|ssh:|javascript:)/i.test(href);
}

function stripFragmentAndQuery(href: string): string {
  return href.split('#')[0].split('?')[0];
}

function stripLineSuffix(href: string): string {
  return href.replace(/:\d+$/, '');
}

async function listMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  await Promise.all(
    entries.map(async (e) => {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        const nested = await listMarkdown(abs);
        out.push(...nested);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(abs);
      }
    }),
  );
  return out;
}

export function extractLinks(body: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  const lines = body.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const sanitized = line.replace(INLINE_CODE_RE, '');
    INLINE_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INLINE_LINK_RE.exec(sanitized)) !== null) {
      links.push({ href: m[1], line: i + 1 });
    }
  }
  return links;
}

async function readDoc(repoRoot: string, abs: string): Promise<ScannedDoc> {
  const body = await fs.readFile(abs, 'utf8');
  return {
    absPath: abs,
    relPath: toPosix(path.relative(repoRoot, abs)),
    body,
    links: extractLinks(body),
  };
}

function resolveLinkTarget(
  repoRoot: string,
  fromAbs: string,
  href: string,
): string | null {
  const cleaned = stripLineSuffix(stripFragmentAndQuery(href));
  if (!cleaned) return null;
  if (cleaned.startsWith('/')) {
    return path.resolve(repoRoot, '.' + cleaned);
  }
  return path.resolve(path.dirname(fromAbs), cleaned);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export function parseLogHeaders(body: string): LogEntry[] {
  const lines = body.split(/\r?\n/);
  const out: LogEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const withRun = line.match(LOG_HEADER_WITH_RUN_RE);
    if (withRun) {
      out.push({
        line: i + 1,
        date: withRun[1],
        runNumber: Number(withRun[2]),
        raw: line,
      });
      continue;
    }
    const dateOnly = line.match(LOG_HEADER_DATE_ONLY_RE);
    if (dateOnly) {
      out.push({
        line: i + 1,
        date: dateOnly[1],
        runNumber: null,
        raw: line,
      });
    }
  }
  return out;
}

function compareLogEntries(a: LogEntry, b: LogEntry): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ar = a.runNumber ?? -Infinity;
  const br = b.runNumber ?? -Infinity;
  if (ar === br) return 0;
  return ar < br ? -1 : 1;
}

function findDuplicates(entries: LogEntry[]): string[] {
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  for (const e of entries) {
    const key = `${e.date}#${e.runNumber ?? 'na'}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      dupes.push(`docs/log.md:${e.line} duplicate of line ${prior} (${key})`);
    } else {
      seen.set(key, e.line);
    }
  }
  return dupes;
}

function findOutOfOrder(entries: LogEntry[]): string[] {
  const issues: string[] = [];
  for (let i = 1; i < entries.length; i++) {
    if (compareLogEntries(entries[i - 1], entries[i]) < 0) {
      issues.push(
        `docs/log.md:${entries[i].line} (${entries[i].date}#${entries[i].runNumber ?? 'na'}) is newer than line ${entries[i - 1].line} (${entries[i - 1].date}#${entries[i - 1].runNumber ?? 'na'}) — newest must be at top`,
      );
    }
  }
  return issues;
}

export function checkFrontmatter(body: string): boolean {
  const lines = body.split(/\r?\n/);
  let i = 0;
  let sawH1 = false;
  for (; i < lines.length && i < 100; i++) {
    if (/^#\s+\S/.test(lines[i])) {
      sawH1 = true;
      break;
    }
  }
  if (!sawH1) return false;
  const horizon = Math.min(lines.length - 1, i + 40);
  for (let j = i + 1; j <= horizon; j++) {
    const cur = lines[j];
    const next = lines[j + 1] ?? '';
    if (TABLE_HEADER_RE.test(cur) && TABLE_DIVIDER_RE.test(next)) {
      return true;
    }
  }
  return false;
}

export async function lintDocs(repoRoot: string): Promise<DocLintResult> {
  const result: DocLintResult = {
    brokenLinks: [],
    unindexedDocs: [],
    duplicateLogEntries: [],
    outOfOrderLogEntries: [],
    missingFrontmatter: [],
    overlappingRanges: [],
    outOfBandSpecs: [],
    ok: true,
  };

  // 1. Discover markdown files under SCAN_ROOTS.
  const docPathLists = await Promise.all(
    SCAN_ROOTS.map((r) => listMarkdown(path.join(repoRoot, r))),
  );
  const docPaths = docPathLists.flat();
  const docs = await Promise.all(docPaths.map((p) => readDoc(repoRoot, p)));
  docs.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));

  // 2. Broken-link check.
  await Promise.all(
    docs.map(async (doc) => {
      for (const link of doc.links) {
        if (isExternal(link.href)) continue;
        if (link.href.startsWith('#')) continue;
        const target = resolveLinkTarget(repoRoot, doc.absPath, link.href);
        if (!target) continue;
        if (!(await exists(target))) {
          result.brokenLinks.push({
            from: `${doc.relPath}:${link.line}`,
            to: link.href,
          });
        }
      }
    }),
  );
  result.brokenLinks.sort((a, b) => (a.from < b.from ? -1 : 1));

  // 3. Indexed-doc check.
  const indexAbs = path.join(repoRoot, 'docs', 'index.md');
  const indexedTargets = new Set<string>();
  if (await exists(indexAbs)) {
    const indexDoc = await readDoc(repoRoot, indexAbs);
    for (const link of indexDoc.links) {
      if (isExternal(link.href)) continue;
      if (link.href.startsWith('#')) continue;
      const target = resolveLinkTarget(repoRoot, indexAbs, link.href);
      if (target) {
        indexedTargets.add(toPosix(path.relative(repoRoot, target)));
      }
    }
  }

  for (const doc of docs) {
    if (INDEX_EXEMPT.has(doc.relPath)) continue;
    if (doc.relPath.startsWith(TEMPLATE_PREFIX)) continue;
    if (!indexedTargets.has(doc.relPath)) {
      result.unindexedDocs.push(doc.relPath);
    }
  }
  result.unindexedDocs.sort();

  // 4. log.md duplicate + ordering check.
  const logDoc = docs.find((d) => d.relPath === 'docs/log.md');
  if (logDoc) {
    const entries = parseLogHeaders(logDoc.body);
    result.duplicateLogEntries = findDuplicates(entries);
    result.outOfOrderLogEntries = findOutOfOrder(entries);
  }

  // 5. Frontmatter check on spec/plan under .specify/specs/.
  // tasks.md is intentionally exempt — see SPEC_FRONTMATTER_RE comment.
  for (const doc of docs) {
    if (SPEC_FRONTMATTER_RE.test(doc.relPath)) {
      if (!checkFrontmatter(doc.body)) {
        result.missingFrontmatter.push(doc.relPath);
      }
    }
  }
  result.missingFrontmatter.sort();

  // 6. Fork range-registry checks (only when .specify/ranges.json exists).
  const ranges = await loadRanges(repoRoot);
  if (ranges && ranges.length > 0) {
    result.overlappingRanges = findOverlaps(ranges);
    const specDirs = await fs
      .readdir(path.join(repoRoot, '.specify', 'specs'), { withFileTypes: true })
      .catch(() => [] as import('fs').Dirent[]);
    const offenders = new Set<string>();
    for (const e of specDirs) {
      if (!e.isDirectory()) continue;
      const n = extractSpecNumber(e.name);
      if (n === null) continue;
      if (!rangeForNumber(ranges, n)) {
        offenders.add(`${e.name} (number ${n} is outside every reserved band)`);
      }
    }
    result.outOfBandSpecs = [...offenders].sort();
  }

  result.ok =
    result.brokenLinks.length === 0 &&
    result.unindexedDocs.length === 0 &&
    result.duplicateLogEntries.length === 0 &&
    result.outOfOrderLogEntries.length === 0 &&
    result.missingFrontmatter.length === 0 &&
    result.overlappingRanges.length === 0 &&
    result.outOfBandSpecs.length === 0;

  return result;
}

export function formatResult(result: DocLintResult): string {
  const lines: string[] = [];
  if (result.brokenLinks.length) {
    lines.push(`✗ ${result.brokenLinks.length} broken link(s):`);
    for (const b of result.brokenLinks) lines.push(`    ${b.from} → ${b.to}`);
  }
  if (result.unindexedDocs.length) {
    lines.push(
      `✗ ${result.unindexedDocs.length} doc(s) not linked from docs/index.md:`,
    );
    for (const u of result.unindexedDocs) lines.push(`    ${u}`);
  }
  if (result.duplicateLogEntries.length) {
    lines.push(`✗ ${result.duplicateLogEntries.length} duplicate log entry/entries:`);
    for (const d of result.duplicateLogEntries) lines.push(`    ${d}`);
  }
  if (result.outOfOrderLogEntries.length) {
    lines.push(
      `✗ ${result.outOfOrderLogEntries.length} log entry/entries violate newest-at-top order:`,
    );
    for (const o of result.outOfOrderLogEntries) lines.push(`    ${o}`);
  }
  if (result.missingFrontmatter.length) {
    lines.push(
      `✗ ${result.missingFrontmatter.length} spec file(s) missing H1 + metadata table:`,
    );
    for (const m of result.missingFrontmatter) lines.push(`    ${m}`);
  }
  if (result.overlappingRanges.length) {
    lines.push(
      `✗ ${result.overlappingRanges.length} overlapping fork range(s) in .specify/ranges.json:`,
    );
    for (const o of result.overlappingRanges) lines.push(`    ${o}`);
  }
  if (result.outOfBandSpecs.length) {
    lines.push(
      `✗ ${result.outOfBandSpecs.length} spec(s) outside every reserved range:`,
    );
    for (const s of result.outOfBandSpecs) lines.push(`    ${s}`);
  }
  if (result.ok) lines.push('✓ Doc-lint passed — no issues.');
  return lines.join('\n');
}

// CLI entry — runs only when this file is the program entrypoint.
// Uses a CJS/ESM-tolerant detection so the script works under both
// Node 20 ts-node-CJS (CI) and Node 24 ts-node-ESM (local dev box).
function isCliEntry(): boolean {
  try {
    if (typeof require !== 'undefined' && require.main === module) {
      return true;
    }
  } catch {
    /* not running in CJS — fall through */
  }
  // Fallback for ESM: argv[1] should resolve to this file.
  const entry = process.argv[1] ?? '';
  return entry.endsWith('docs-lint.ts') || entry.endsWith('docs-lint.js');
}

if (isCliEntry()) {
  // `__dirname` is unavailable under pure ESM; fall back to `process.cwd()`
  // when not present (the npm script always runs from the repo root).
  const here =
    typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const repoRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(here, here.endsWith('scripts') ? '..' : '.');
  lintDocs(repoRoot)
    .then((res) => {
      // eslint-disable-next-line no-console
      console.log(formatResult(res));
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('docs-lint failed:', err);
      process.exit(2);
    });
}
