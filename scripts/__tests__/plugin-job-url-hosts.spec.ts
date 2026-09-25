/**
 * Lint: no source plugin may wire an API endpoint into a user-facing link
 * (Spec 1751).
 *
 * `JobPostDto.jobUrl`, `jobUrlDirect` and `applyUrl` are the links a downstream
 * app renders ("Apply" = `applyUrl ?? jobUrl ?? jobUrlDirect`). Until Spec 1750
 * `source-ats-smartrecruiters` set `jobUrl = job.ref`, the posting's API
 * resource (`https://api.smartrecruiters.com/v1/companies/<Co>/postings/<id>`),
 * and thousands of stored rows sent people to raw JSON. Its unit fixtures had a
 * fabricated public `ref`, so every test stayed green.
 *
 * This guard reads every `packages/plugins/<plugin>/src/**\/*.ts` with the
 * TypeScript parser and, for every assignment to one of those three fields
 * (`jobUrl: …`, `const jobUrl = …`, `post.applyUrl = …`), fails when the value:
 *
 *  1. reads a source field that is by definition an API reference (`.ref`,
 *     `.self`, `.apiUrl`, `.api_url`, `.resource_uri`) — directly, or through a
 *     local variable or a helper's `return`, but not through a call argument
 *     (a call such as `parseRef(job.ref)` transforms the value); or
 *  2. contains a URL string fragment matching `API_URL_PATTERN` from
 *     `@ever-jobs/common` (an `api.` host, `/api/`, `/v1/`, `graphql`,
 *     `/wday/cxs/`, `/rest-services/`, `.json`, …) — in the expression itself,
 *     in a same-plugin constant or local it names (resolved lexically, so two
 *     functions' unrelated `url` locals never mix), or in a same-plugin helper
 *     it calls.
 *
 * 🛑 Values only known at runtime (`job.url` from a response) cannot be judged
 * statically; `firstPublicUrl()` guards those at runtime. This guard catches
 * the shape that shipped: an API host or API field wired in by code.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import { API_URL_PATTERN } from '../../packages/common/src/utils/public-url';

/** The `JobPostDto` fields a person clicks. */
const LINK_FIELDS = new Set(['jobUrl', 'jobUrlDirect', 'applyUrl']);

/** Source fields that name an API resource, never a page. */
const API_REFERENCE_FIELDS = new Set(['ref', 'self', 'apiUrl', 'api_url', 'resource_uri']);

/**
 * `URL` accessors whose value is part of the receiver URL, so `x.origin` of an
 * API URL is still an API link. Any other property read (`detail.applyUrl`) is
 * runtime data and is not traced back into the receiver.
 */
const URL_PART_ACCESSORS = new Set(['origin', 'host', 'hostname', 'href', 'protocol', 'pathname', 'toString']);

/** How deep identifier / helper resolution follows a value. */
const MAX_DEPTH = 6;

/**
 * Plugins that still emit an API URL as a LAST RESORT, when no public page is
 * known for the tenant (Q-110). Each one already prefers every public
 * candidate (`firstPublicUrl`) and the caller's `companyUrl`; the entry must
 * name why the fallback remains. An entry that no longer produces a finding
 * fails the suite, so a fixed plugin cannot stay excused.
 */
export const KNOWN_EXCEPTIONS: Readonly<Record<string, string>> = {
  'source-ats-bullhorn':
    'Bullhorn exposes no public posting page for a corp token; the REST entity URL is used only when the caller gives no companyUrl (Q-110).',
  'source-ats-ceipal':
    'A bare Ceipal portal key names no public page; the JSON detail resource is used only when apply_job, companyUrl and the syndication links are all absent (Q-110).',
  'source-ats-hiringthing':
    'No public posting pattern is known for a HiringThing account; the api host link is used only when the API omits `url` and no companyUrl is given (Q-110).',
  'source-ats-loxo':
    'No public posting pattern is known for a Loxo agency; the API resource is used only when `url`, `apply_url` and companyUrl are all absent (Q-110).',
};

export interface JobUrlFinding {
  plugin: string;
  file: string;
  line: number;
  field: string;
  reason: string;
}

export interface ScanResult {
  findings: JobUrlFinding[];
  /** Link assignments inspected — proves the scan saw the tree. */
  assignments: number;
}

interface PluginIndex {
  /** Top-level / exported `const` initializers and class property initializers, by name. */
  values: Map<string, ts.Expression[]>;
  /** Functions, arrow-function constants and methods, by name. */
  functions: Map<string, ts.FunctionLikeDeclaration[]>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function indexPlugin(sources: ts.SourceFile[]): PluginIndex {
  const values = new Map<string, ts.Expression[]>();
  const functions = new Map<string, ts.FunctionLikeDeclaration[]>();
  for (const sf of sources) {
    for (const stmt of sf.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
          const init = decl.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            push(functions, decl.name.text, init);
          } else {
            push(values, decl.name.text, init);
          }
        }
      } else if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
        push(functions, stmt.name.text, stmt);
      } else if (ts.isClassDeclaration(stmt)) {
        for (const member of stmt.members) {
          if (!member.name || !ts.isIdentifier(member.name)) continue;
          if (ts.isMethodDeclaration(member) && member.body) {
            push(functions, member.name.text, member);
          } else if (ts.isPropertyDeclaration(member) && member.initializer) {
            const init = member.initializer;
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
              push(functions, member.name.text, init);
            } else {
              push(values, member.name.text, init);
            }
          }
        }
      }
    }
  }
  return { values, functions };
}

/** The `return` expressions of a function (an arrow's expression body counts). */
function returnsOf(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    if (ts.isFunctionLike(node)) return; // a nested function's returns are not ours
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

/**
 * Resolve an identifier at `use` to the initializer of the nearest enclosing
 * declaration. `null` = declared but not statically known (a parameter, a
 * destructured binding); `undefined` = not declared in an enclosing scope.
 */
function resolveLexical(use: ts.Identifier): ts.Expression | null | undefined {
  const name = use.text;
  let node: ts.Node | undefined = use.parent;
  while (node) {
    if (ts.isFunctionLike(node)) {
      for (const p of node.parameters) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return null;
      }
    }
    const statements: readonly ts.Statement[] | undefined =
      ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)
        ? node.statements
        : ts.isCaseClause(node) || ts.isDefaultClause(node)
          ? node.statements
          : undefined;
    if (statements) {
      for (const stmt of statements) {
        if (!ts.isVariableStatement(stmt)) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name) {
            return decl.initializer ?? null;
          }
          if (!ts.isIdentifier(decl.name)) {
            // a destructured name is declared here but not statically known
            const names: string[] = [];
            const collect = (b: ts.BindingName): void => {
              if (ts.isIdentifier(b)) names.push(b.text);
              else b.elements.forEach((e) => { if (!ts.isOmittedExpression(e)) collect(e.name); });
            };
            collect(decl.name);
            if (names.includes(name)) return null;
          }
        }
      }
    }
    node = node.parent;
  }
  return undefined;
}

/** Literal text of a string-ish node; template holes become `${}`. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => '${}' + s.literal.text).join('');
  }
  return null;
}

function analyseValue(
  root: ts.Expression,
  index: PluginIndex,
): string[] {
  const reasons = new Set<string>();
  const seen = new Set<ts.Node>();

  const visit = (node: ts.Node, depth: number, refRule: boolean): void => {
    if (depth > MAX_DEPTH || seen.has(node)) return;
    seen.add(node);

    const text = literalText(node);
    if (text !== null && API_URL_PATTERN.test(text)) {
      reasons.add(`API-shaped URL "${text.slice(0, 100)}"`);
    }

    if (ts.isIdentifier(node)) {
      const local = resolveLexical(node);
      if (local) {
        visit(local, depth + 1, refRule);
      } else if (local === undefined) {
        for (const v of index.values.get(node.text) ?? []) visit(v, depth + 1, refRule);
      }
      return;
    }

    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        for (const v of index.values.get(name) ?? []) visit(v, depth + 1, refRule);
        return;
      }
      if (refRule && API_REFERENCE_FIELDS.has(name)) {
        reasons.add(`reads API reference field ".${name}" (${node.getText().slice(0, 60)})`);
      }
      // `CONSTANTS.KEY` on an object-literal constant
      let objectConstant = false;
      if (ts.isIdentifier(node.expression)) {
        for (const v of index.values.get(node.expression.text) ?? []) {
          let obj: ts.Expression = v;
          while (ts.isAsExpression(obj) || ts.isParenthesizedExpression(obj) || ts.isSatisfiesExpression(obj)) {
            obj = obj.expression;
          }
          if (ts.isObjectLiteralExpression(obj)) {
            objectConstant = true;
            for (const prop of obj.properties) {
              if (ts.isPropertyAssignment(prop) && prop.name.getText().replace(/['"]/g, '') === name) {
                visit(prop.initializer, depth + 1, refRule);
              }
            }
          }
        }
      }
      // `u.origin` of a `new URL(apiBase)` still carries the API host, but
      // `detail.applyUrl` of a fetched `detail` is runtime data — the URL the
      // detail was fetched FROM is not the value, so do not descend into it.
      if (!objectConstant && URL_PART_ACCESSORS.has(name)) {
        visit(node.expression, depth, refRule);
      }
      return;
    }

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const fnName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword
          ? callee.name.text
          : null;
      if (fnName) {
        for (const fn of index.functions.get(fnName) ?? []) {
          for (const ret of returnsOf(fn)) visit(ret, depth + 1, true);
        }
      } else if (ts.isPropertyAccessExpression(callee)) {
        // `TEMPLATE.replace(…)`: the receiver is still the URL being built
        visit(callee.expression, depth, false);
      }
      for (const arg of node.arguments ?? []) visit(arg, depth, false);
      return;
    }

    if (ts.isFunctionLike(node)) return; // a callback's body is not the value
    ts.forEachChild(node, (child) => visit(child, depth, refRule));
  };

  visit(root, 0, true);
  return [...reasons];
}

/** Scan one plugin's sources; `plugin` labels the findings. */
export function scanPlugin(
  plugin: string,
  files: Array<{ file: string; text: string }>,
): ScanResult {
  const sources = files.map((f) =>
    ts.createSourceFile(f.file, f.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  );
  const index = indexPlugin(sources);
  const findings: JobUrlFinding[] = [];
  let assignments = 0;

  for (const sf of sources) {
    const check = (at: ts.Node, field: string, value: ts.Expression | undefined): void => {
      if (!value) return;
      assignments += 1;
      for (const reason of analyseValue(value, index)) {
        findings.push({
          plugin,
          file: sf.fileName,
          line: sf.getLineAndCharacterOfPosition(at.getStart()).line + 1,
          field,
          reason,
        });
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node)) {
        const key = node.name.getText().replace(/['"]/g, '');
        if (LINK_FIELDS.has(key)) check(node, key, node.initializer);
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && LINK_FIELDS.has(node.name.text)) {
        check(node, node.name.text, node.initializer);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = node.left;
        const key = ts.isIdentifier(left)
          ? left.text
          : ts.isPropertyAccessExpression(left)
            ? left.name.text
            : null;
        if (key && LINK_FIELDS.has(key)) check(node, key, node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { findings, assignments };
}

const REPO_ROOT = path.join(__dirname, '..', '..');
const PLUGINS_DIR = path.join(REPO_ROOT, 'packages', 'plugins');

function listTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listTs(p, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Scan every `packages/plugins/<plugin>/src` tree that assigns a link field. */
export function scanRepoPlugins(): ScanResult & { plugins: number } {
  const findings: JobUrlFinding[] = [];
  let assignments = 0;
  let plugins = 0;
  for (const plugin of fs.readdirSync(PLUGINS_DIR)) {
    const src = path.join(PLUGINS_DIR, plugin, 'src');
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue;
    const files = listTs(src).map((file) => ({
      file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
      text: fs.readFileSync(file, 'utf8'),
    }));
    if (!files.some((f) => /\b(?:jobUrl|jobUrlDirect|applyUrl)\b/.test(f.text))) continue;
    plugins += 1;
    const result = scanPlugin(plugin, files);
    findings.push(...result.findings);
    assignments += result.assignments;
  }
  return { findings, assignments, plugins };
}

function scanSnippet(text: string, extra: Array<{ file: string; text: string }> = []): JobUrlFinding[] {
  return scanPlugin('fixture', [{ file: 'fixture.service.ts', text }, ...extra]).findings;
}

describe('plugin job links never point at an API (Spec 1751)', () => {
  describe('scanPlugin — detection', () => {
    it('flags jobUrl = job.ref (the Spec 1750 bug)', () => {
      const findings = scanSnippet(`
        function map(job: any, slug: string) {
          const jobUrl = job.ref ?? \`https://jobs.smartrecruiters.com/\${slug}/\${job.id}\`;
          return { jobUrl };
        }`);
      expect(findings).toHaveLength(1);
      expect(findings[0].field).toBe('jobUrl');
      expect(findings[0].reason).toContain('.ref');
    });

    it('flags an API host literal and an API host reached through a constant in another file', () => {
      const findings = scanSnippet(
        `import { API_BASE } from './c';
         const a = { jobUrl: \`https://api.acme.com/jobs/\${1}\` };
         const b = { applyUrl: \`\${API_BASE}/\${2}\` };`,
        [{ file: 'c.ts', text: `export const API_BASE = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs';` }],
      );
      expect(findings.map((f) => f.field).sort()).toEqual(['applyUrl', 'jobUrl']);
    });

    it('follows a same-plugin helper and a TEMPLATE.replace() receiver', () => {
      const findings = scanSnippet(`
        const PAGE = 'https://api.ceipal.com/{key}/job-postings/{id}/';
        class S {
          private build(id: string): string { return PAGE.replace('{id}', id); }
          map(id: string) { return { jobUrl: this.build(id) }; }
        }`);
      expect(findings).toHaveLength(1);
      expect(findings[0].reason).toContain('api.ceipal.com');
    });

    it('flags an assignment through a member (post.applyUrl = …)', () => {
      const findings = scanSnippet(`function f(post: any) { post.applyUrl = 'https://x.com/api/jobs/1'; }`);
      expect(findings).toHaveLength(1);
      expect(findings[0].field).toBe('applyUrl');
    });

    it('resolves locals lexically: another function\'s API `url` does not taint this one', () => {
      const findings = scanSnippet(`
        async function list() { const url = 'https://api.acme.com/v1/jobs'; return url; }
        function map(id: string) {
          const url = \`https://careers.acme.com/jobs/\${id}\`;
          return { jobUrl: url };
        }`);
      expect(findings).toEqual([]);
    });

    it('traces a URL accessor (u.origin of an API URL) but not a fetched field (detail.applyUrl)', () => {
      const findings = scanSnippet(`
        async function map(client: any, id: string) {
          const u = new URL('https://api.acme.com/v1/jobs');
          const detail = await client.get(\`https://api.acme.com/v1/jobs/\${id}\`);
          return { jobUrl: \`\${u.origin}/careers/\${id}\`, applyUrl: detail.applyUrl };
        }`);
      expect(findings.map((f) => f.field)).toEqual(['jobUrl']);
    });

    it('does not flag .ref passed through a call (it is transformed, not linked)', () => {
      const findings = scanSnippet(`
        function map(job: any) {
          const fromRef = parseRef(job.ref);
          const id = job.id ?? fromRef?.postingId;
          return { jobUrl: \`https://jobs.smartrecruiters.com/\${fromRef?.co}/\${id}\` };
        }
        function parseRef(ref: string) { return { co: 'A', postingId: '1' }; }`);
      expect(findings).toEqual([]);
    });

    it('ignores type declarations and public hosts', () => {
      const findings = scanSnippet(`
        interface J { jobUrl: string; applyUrl?: string | null }
        const x = {
          jobUrl: job.absolute_url ?? \`https://boards.greenhouse.io/\${slug}/jobs/\${id}\`,
          applyUrl: \`https://jobs.lever.co/\${slug}/\${id}/apply\`,
          jobUrlDirect: 'https://www.paycomonline.net/v4/ats/web.php/portal/A/jobs/1',
        };`);
      expect(findings).toEqual([]);
    });
  });

  describe('the plugin tree', () => {
    let result: ReturnType<typeof scanRepoPlugins>;
    beforeAll(() => {
      result = scanRepoPlugins();
    }, 180_000);

    it('actually scanned the tree (non-vacuous)', () => {
      // ~1,160 plugins / ~1,560 link assignments on 2026-09-25.
      expect(result.plugins).toBeGreaterThan(1000);
      expect(result.assignments).toBeGreaterThan(1400);
    });

    it('no plugin wires an API URL or API field into jobUrl / jobUrlDirect / applyUrl', () => {
      const unexpected = result.findings
        .filter((f) => !(f.plugin in KNOWN_EXCEPTIONS))
        .map((f) => `${f.file}:${f.line} ${f.field} — ${f.reason}`);
      expect(unexpected).toEqual([]);
    });

    it('every documented exception still applies (a fixed plugin loses its excuse)', () => {
      const flagged = new Set(result.findings.map((f) => f.plugin));
      const stale = Object.keys(KNOWN_EXCEPTIONS).filter((p) => !flagged.has(p));
      expect(stale).toEqual([]);
    });

    it('source-ats-smartrecruiters is clean (Spec 1750)', () => {
      expect(result.findings.filter((f) => f.plugin === 'source-ats-smartrecruiters')).toEqual([]);
    });
  });
});
