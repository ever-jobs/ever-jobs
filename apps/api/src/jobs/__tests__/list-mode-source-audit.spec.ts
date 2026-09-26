import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { SOURCE_PLUGIN_METADATA, type IPluginMetadata } from '@ever-jobs/plugin';
import { BaytService } from '@ever-jobs/source-bayt';
import { CareerOneStopService } from '@ever-jobs/source-careeronestop';
import { NaukriService } from '@ever-jobs/source-naukri';
import { StepStoneService } from '@ever-jobs/source-stepstone';

/**
 * Spec 1720 — static guard for list mode.
 *
 * In list mode the orchestrator hands every plugin an ABSENT `searchTerm`.
 * A plugin that interpolates it bare — `${input.searchTerm}`,
 * `'q=' + input.searchTerm`, `String(input.searchTerm)`, `input.searchTerm!`
 * — would put the literal string "undefined" into a URL or query body.
 * TypeScript does not catch template literals or `+` concatenation, so this
 * scan does. The safe spellings (`if (input.searchTerm)`,
 * `input.searchTerm ?? ''`) are not matched.
 *
 * Review fix (Spec 1720 / FR-11): two more ways a plugin fails list mode
 * without ever printing "undefined", both invisible to the checks above:
 *
 *   - a DEFAULT KEYWORD — `input.searchTerm ?? 'developer'` turns list mode
 *     into a silent keyword search (found in `source-stepstone`);
 *   - the term as a URL PATH SEGMENT — `/${userId}/${keyword}/${location}`
 *     becomes `//` without a term, a malformed request rather than a listing
 *     (found in `source-careeronestop`).
 *
 * Both are only offences in plugins that list mode actually calls, i.e. not
 * flagged `requiresSearchTerm: true`; a default keyword inside a log call is
 * harmless and ignored.
 *
 * The scan covers every plugin's `src/` (~1 860 packages) and runs in ~1 s.
 */

const PLUGINS_DIR = path.resolve(__dirname, '../../../../../packages/plugins');

const BARE_TERM_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'template interpolation', re: /\$\{\s*input\.(?:searchTerm|googleSearchTerm)\s*\}/ },
  { name: 'concatenation (term on the right)', re: /\+\s*input\.(?:searchTerm|googleSearchTerm)\b(?!\s*\?\?)/ },
  { name: 'concatenation (term on the left)', re: /\binput\.(?:searchTerm|googleSearchTerm)\s*\+(?!\+)/ },
  { name: 'String() coercion', re: /String\(\s*input\.(?:searchTerm|googleSearchTerm)\s*\)/ },
  { name: 'non-null assertion', re: /\binput\.(?:searchTerm|googleSearchTerm)!(?!=)/ },
];

/** `searchTerm ?? 'x'` / `searchTerm || "x"` with a NON-empty literal. */
const KEYWORD_FALLBACK = /\b(?:searchTerm|googleSearchTerm)\s*(?:\?\?|\|\|)\s*(['"`])(?!\1)/;

/** The opening of a logger / console call. */
const LOG_CALL = /\b(?:logger|console)\.(?:log|debug|verbose|info|warn|error)\s*\(/;

/** `requiresSearchTerm: true` in a plugin's `@SourcePlugin(...)` metadata. */
const REQUIRES_SEARCH_TERM = /\brequiresSearchTerm\s*:\s*true\b/;

function findOffences(source: string): string[] {
  const hits: string[] = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    for (const { name, re } of BARE_TERM_PATTERNS) {
      if (re.test(line)) hits.push(`${i + 1}: ${name}: ${line.trim()}`);
    }
  });
  return hits;
}

/**
 * True when line `i` belongs to a logger/console call: the call opens on this
 * line, or on one of the three before it without a statement ending between.
 */
function inLogCall(lines: ReadonlyArray<string>, i: number): boolean {
  for (let j = i; j >= Math.max(0, i - 3); j--) {
    const line = lines[j] ?? '';
    // A previous line that ends a statement ends the search, even when that
    // statement was itself a (complete, one-line) log call.
    if (j < i && /;\s*$/.test(line)) return false;
    if (LOG_CALL.test(line)) return true;
  }
  return false;
}

/** Local names assigned from the term, e.g. `const keyword = encodeURIComponent(input.searchTerm ?? '')`. */
function termVariables(source: string): string[] {
  const names = new Set<string>();
  const assigned = /(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*\binput\.(?:searchTerm|googleSearchTerm)\b/g;
  let m: RegExpExecArray | null;
  while ((m = assigned.exec(source))) names.add(m[1]!);
  if (/(?:const|let|var)\s*\{[^}]*\bsearchTerm\b[^}]*\}\s*=\s*input\b/.test(source)) names.add('searchTerm');
  return [...names];
}

/**
 * Offences that only matter when list mode calls the plugin: a default
 * keyword, and the term as a path segment (followed by `/` or `-`; at the very
 * end of a path an empty term usually still names a listing page).
 */
function findListModeOffences(source: string): string[] {
  const hits: string[] = [];
  const lines = source.split('\n');
  const segmentPatterns = [
    { name: 'term as a path segment', re: /\/\$\{[^}]*\binput\.(?:searchTerm|googleSearchTerm)\b[^}]*\}[/-]/ },
    ...termVariables(source).map((name) => ({
      name: `term as a path segment (via \`${name}\`)`,
      re: new RegExp(`/\\$\\{\\s*${name}\\s*\\}[/-]`),
    })),
  ];
  lines.forEach((line, i) => {
    if (KEYWORD_FALLBACK.test(line) && !inLogCall(lines, i)) {
      hits.push(`${i + 1}: default keyword: ${line.trim()}`);
    }
    for (const { name, re } of segmentPatterns) {
      if (re.test(line)) hits.push(`${i + 1}: ${name}: ${line.trim()}`);
    }
  });
  return hits;
}

function* walkTs(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      yield* walkTs(full);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      yield full;
    }
  }
}

/** Every plugin package's source files, and whether it is keyword-only. */
function scanPlugins(): Array<{ pkg: string; files: Array<{ file: string; text: string }>; keywordOnly: boolean }> {
  const out: Array<{ pkg: string; files: Array<{ file: string; text: string }>; keywordOnly: boolean }> = [];
  for (const pkg of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = path.join(PLUGINS_DIR, pkg.name, 'src');
    if (!fs.existsSync(src)) continue;
    const files = [...walkTs(src)].map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
    out.push({
      pkg: pkg.name,
      files,
      keywordOnly: files.some(({ text }) => REQUIRES_SEARCH_TERM.test(text)),
    });
  }
  return out;
}

describe('list-mode source audit (Spec 1720)', () => {
  const plugins = scanPlugins();

  it('the detector catches every bare spelling (red control)', () => {
    const planted = [
      'const url = `https://x/search?q=${input.searchTerm}`;',
      "const url = BASE + '?q=' + input.searchTerm;",
      'const q = input.searchTerm + " jobs";',
      'params.set("q", String(input.searchTerm));',
      'const slug = input.searchTerm!.toLowerCase();',
      'const g = `${input.googleSearchTerm}`;',
    ].join('\n');
    expect(findOffences(planted)).toHaveLength(6);
  });

  it('the detector accepts the safe spellings', () => {
    const safe = [
      'if (input.searchTerm) { params.q = input.searchTerm; }',
      "const term = input.searchTerm ?? '';",
      "const url = `https://x/search?q=${encodeURIComponent(input.searchTerm ?? '')}`;",
      'if (input.searchTerm && !this.matchesSearch(item, input.searchTerm)) continue;',
      'const same = input.searchTerm !== undefined;',
      "const q = 'q=' + (input.searchTerm ?? '');",
    ].join('\n');
    expect(findOffences(safe)).toEqual([]);
  });

  it('no plugin interpolates an absent searchTerm into a request', () => {
    const offences: string[] = [];
    let scanned = 0;
    for (const { files } of plugins) {
      for (const { file, text } of files) {
        scanned++;
        if (!text.includes('searchTerm')) continue;
        for (const hit of findOffences(text)) {
          offences.push(`${path.relative(PLUGINS_DIR, file)}:${hit}`);
        }
      }
    }
    // Guard against a vacuous pass (wrong directory, empty checkout).
    expect(scanned).toBeGreaterThan(1_000);
    expect(offences).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Review fix (Spec 1720 / FR-11)
  // ---------------------------------------------------------------------

  it('the list-mode detector catches default keywords and path-segment terms (red control)', () => {
    const planted = [
      "const searchTerm = (input.searchTerm ?? 'developer').replace(/\\s+/g, '-');",
      'const q = (input.searchTerm || "jobs").trim();',
      'const g = input.googleSearchTerm ?? `software`;',
      "const keyword = encodeURIComponent(input.searchTerm ?? '');",
      'const url = `${API}/${this.userId}/${keyword}/${location}/25`;',
      "const page = `${BASE}/jobs/${input.searchTerm ?? ''}-jobs/`;",
    ].join('\n');
    const hits = findListModeOffences(planted);
    expect(hits).toHaveLength(5);
    expect(hits.filter((h) => h.includes('default keyword'))).toHaveLength(3);
    expect(hits.filter((h) => h.includes('path segment'))).toHaveLength(2);
  });

  it('the list-mode detector accepts log lines, empty fallbacks and a trailing term', () => {
    const safe = [
      'this.logger.log(',
      "  `Fetching Jobs.ch jobs (resultsWanted=${n}, searchTerm=${input.searchTerm ?? 'none'})`,",
      ');',
      "this.logger.debug(`term=${input.searchTerm ?? '<none>'}`);",
      "const term = input.searchTerm ?? '';",
      'const term2 = input.searchTerm || "";',
      "const url = `${BASE}/search/${encodeURIComponent(input.searchTerm ?? '')}`;",
      "const keyword = encodeURIComponent(input.searchTerm ?? '');",
      'const url2 = `${BASE}/search?q=${keyword}`;',
    ].join('\n');
    expect(findListModeOffences(safe)).toEqual([]);
  });

  it('a log call does not exempt the NEXT statement', () => {
    const source = [
      "this.logger.log('starting');",
      "const q = input.searchTerm ?? 'developer';",
    ].join('\n');
    expect(findListModeOffences(source)).toHaveLength(1);
  });

  it('no plugin that list mode calls substitutes a keyword or needs one as a path segment', () => {
    const offences: string[] = [];
    const exempt: string[] = [];
    for (const { pkg, files, keywordOnly } of plugins) {
      const hits = files.flatMap(({ file, text }) =>
        text.includes('earchTerm')
          ? findListModeOffences(text).map((hit) => `${path.relative(PLUGINS_DIR, file)}:${hit}`)
          : [],
      );
      if (hits.length === 0) continue;
      if (keywordOnly) exempt.push(pkg);
      else offences.push(...hits);
    }
    expect(offences).toEqual([]);
    // The exemption is doing real work: the known keyword-only plugins trip
    // the detector and are excused only by their flag.
    expect(exempt).toEqual(
      expect.arrayContaining(['source-careeronestop', 'source-stepstone']),
    );
  });

  it('the keyword-only plugins declare requiresSearchTerm in their runtime metadata', () => {
    for (const cls of [NaukriService, StepStoneService, CareerOneStopService]) {
      const meta = Reflect.getMetadata(SOURCE_PLUGIN_METADATA, cls) as IPluginMetadata | undefined;
      expect({ plugin: cls.name, requiresSearchTerm: meta?.requiresSearchTerm }).toEqual({
        plugin: cls.name,
        requiresSearchTerm: true,
      });
    }
  });

  it('Bayt is listed in list mode: an empty term lists its market page (Spec 1710)', () => {
    const meta = Reflect.getMetadata(SOURCE_PLUGIN_METADATA, BaytService) as IPluginMetadata | undefined;
    expect(meta?.requiresSearchTerm).toBeUndefined();
  });
});
