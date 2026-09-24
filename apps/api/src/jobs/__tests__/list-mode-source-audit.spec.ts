import * as fs from 'fs';
import * as path from 'path';

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

describe('list-mode source audit (Spec 1720)', () => {
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
    for (const pkg of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = path.join(PLUGINS_DIR, pkg.name, 'src');
      if (!fs.existsSync(src)) continue;
      for (const file of walkTs(src)) {
        scanned++;
        const text = fs.readFileSync(file, 'utf8');
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
});
