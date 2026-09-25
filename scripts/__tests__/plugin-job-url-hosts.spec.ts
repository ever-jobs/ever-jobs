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
 * A link is often built one step earlier and COPIED into the DTO later —
 * `{ url: this.buildJobUrl(id) }` in a normalised record, then
 * `jobUrl: job.url` — where `job` is a parameter the guard cannot see through.
 * Two more sinks close that gap (Spec 1751 T11):
 *
 *  3. **Record links.** A value assigned to a key named `url`, `link` or `href`
 *     (`{ url: … }`, `{ url }`, `rec.href = …`) is judged exactly like a link
 *     field — except in a request config (`{ url, method, headers }`, or an
 *     object passed straight to `client.get/post/request/fetch…`), which is a
 *     fetch target.
 *  4. **URL-named helpers.** Every same-plugin function, method or arrow
 *     constant whose name contains `url` (`buildJobUrl`, `jobUrlFor`,
 *     `postingUrl`, `getApplyUrl`, …) has every value it can `return` judged
 *     the same way — wherever its result goes. A helper is exempt only when
 *     every call site hands its result to a request (`client.get(u)`,
 *     `this.fetchJson(u)`, `page.goto(u)`, directly or through a local, a
 *     template, `new URL(u)`, a request config or another helper that returns
 *     it) — logging it, truth-testing it (`if (url)`) or reading a member
 *     (`url.length`) aside: that helper builds a fetch target, and API URLs
 *     used for fetching are fine.
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
 * Keys of an intermediate record whose value a mapper later copies into a link
 * field (`{ url: this.buildJobUrl(id) }` → `jobUrl: job.url`). Exact names only:
 * `detailUrl` / `apiUrl` / `feedUrl` are fetch targets as often as not.
 */
const RECORD_LINK_KEY = /^(?:url|link|href)$/i;

/** A helper named like a URL builder (`buildJobUrl`, `jobUrlFor`, `getApplyUrl`). */
const URL_HELPER_NAME = /url/i;

/**
 * Callees that send a request, so a URL handed to them is a fetch target:
 * `client.get(u)`, `axios.post(u)`, `fetch(u)`, `page.goto(u)`,
 * `this.fetchJson(u)`, `this.getWithRetry(u)`, `this.requestPage(u)`.
 */
const REQUEST_CALLEE = /^(?:get|post|put|patch|head|request|fetch|goto)$|^(?:fetch|request|download|getWith)[A-Z0-9_]/;

/** Logger calls: a URL passed to one is neither fetched nor linked. */
const LOG_CALLEE = /^(?:log|warn|error|debug|verbose|info|trace)$/;

/**
 * Members of a URL string / `URL` whose result is still that URL
 * (`u.toString()`, `tpl.replace(…)`); any other member read (`url.length`,
 * `url.startsWith(…)`) inspects the value without passing it on.
 */
const URL_CARRYING_MEMBERS = new Set([
  'href', 'toString', 'replace', 'replaceAll', 'concat', 'trim', 'slice', 'substring', 'toLowerCase', 'normalize',
]);

/** Keys that mark an object literal as a request config, not a record. */
const REQUEST_CONFIG_KEYS = new Set(['method', 'headers', 'params', 'data', 'body', 'responseType', 'timeout']);

/**
 * Plugins that still emit an API URL (Q-110): four as a LAST RESORT, when no
 * public page is known for the tenant — each already prefers every public
 * candidate (`firstPublicUrl`) and the caller's `companyUrl` — and Zwayam, whose
 * only known share link lives on its API host. The entry must name why the
 * link remains. An entry that no longer produces a finding fails the suite, so
 * a fixed plugin cannot stay excused.
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
  'source-ats-zwayam':
    'buildJobUrl() builds https://api.zwayam.com/job_preview/?jobUrl=…&host=… into the record `url`; zwayam.constants.ts documents it as the share link seen in real job posts AND as the JSON detail endpoint. Unverified live; visible to the guard since T11 (Q-110, Spec 1751 T10).',
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
  /** `url` / `link` / `href` record values inspected (sink 3). */
  recordLinks: number;
  /** URL-named helpers whose returns were inspected (sink 4). */
  urlHelpers: number;
  /** URL-named helpers exempted because every caller only fetches them. */
  fetchHelpers: number;
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
/** The name a call resolves to among the plugin's own helpers (`f(…)`, `this.f(…)`). */
function helperCallName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return resolveLexical(callee) === undefined ? callee.text : null;
  if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return callee.name.text;
  }
  return null;
}

/** The last name of a callee: `client.get` → `get`, `fetch` → `fetch`. */
function calleeName(call: ts.CallExpression | ts.NewExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Every call of a same-plugin helper, by helper name. */
function indexCallSites(sources: ts.SourceFile[], index: PluginIndex): Map<string, ts.CallExpression[]> {
  const calls = new Map<string, ts.CallExpression[]>();
  for (const sf of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = helperCallName(node);
        if (name && index.functions.has(name)) push(calls, name, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return calls;
}

/** The name a function-like is indexed under (declaration, method, `const f = () => …`). */
function functionName(fn: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) {
    return fn.name.text;
  }
  const parent = fn.parent;
  if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

/** Identifiers in the declaring block that read the local `decl` declares. */
function referencesOf(decl: ts.VariableDeclaration): ts.Identifier[] {
  if (!ts.isIdentifier(decl.name)) return [];
  const name = decl.name.text;
  const target = decl.initializer ?? null;
  let scope: ts.Node | undefined = decl.parent;
  while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) scope = scope.parent;
  if (!scope) return [];
  const out: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      node !== decl.name &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      // `url = next` overwrites the local; it does not read the helper's value
      !(ts.isBinaryExpression(node.parent) && node.parent.left === node &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) &&
      resolveLexical(node) === target
    ) {
      out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return out;
}

/** The outermost expression that still carries `expr`'s URL (`await`, `??`, a template, `new URL(…)`). */
function carrierOf(expr: ts.Expression): ts.Expression {
  let e: ts.Expression = expr;
  for (;;) {
    const p = e.parent;
    if (!p) return e;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAwaitExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isTypeAssertionExpression(p)
    ) {
      e = p;
    } else if (
      ts.isBinaryExpression(p) &&
      (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        p.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        p.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      e = p;
    } else if (ts.isConditionalExpression(p) && p.condition !== e) {
      e = p;
    } else if (ts.isTemplateSpan(p)) {
      e = p.parent; // the TemplateExpression
    } else if (ts.isNewExpression(p) && p.expression.getText() === 'URL' && p.arguments?.[0] === e) {
      e = p;
    } else if (ts.isPropertyAccessExpression(p) && p.expression === e && URL_CARRYING_MEMBERS.has(p.name.text)) {
      e = ts.isCallExpression(p.parent) && p.parent.expression === p ? p.parent : p;
    } else {
      return e;
    }
  }
}

/**
 * `request` = handed to a request; `inert` = logged, truth-tested or dropped
 * (neither fetched nor linked); `other` = anything else — a record, a link
 * field, a return nobody calls — so the helper counts as a link helper.
 */
type Use = 'request' | 'inert' | 'other';

/** `if (url)`, `url && …`, `!url`, `while (url …)`: the value is tested, not used. */
function isTruthTest(e: ts.Expression): boolean {
  const p = e.parent;
  if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === e) return true;
  if (ts.isForStatement(p) && p.condition === e) return true;
  if (ts.isConditionalExpression(p) && p.condition === e) return true;
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isTypeOfExpression(p)) return true;
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return p.left === e || isTruthTest(p);
  }
  return false;
}

/**
 * Where the value of `expr` (a helper call) ends up: handed to a request, to a
 * logger, or anywhere else (a record, a link field, a return we cannot follow).
 * Locals, templates, `new URL()` and helpers that `return` it are followed.
 */
function usesOf(
  expr: ts.Expression,
  callSites: Map<string, ts.CallExpression[]>,
  depth: number,
  seenFns: Set<string>,
  out: Use[],
): void {
  if (depth > MAX_DEPTH) {
    out.push('other');
    return;
  }
  const e = carrierOf(expr);
  const p = e.parent;
  if (isTruthTest(e) || (ts.isPropertyAccessExpression(p) && p.expression === e)) {
    // tested, or inspected through a member that does not carry the URL on
    // (`url.length`, `url.startsWith(…)`; carrying members were climbed above)
    out.push('inert');
    return;
  }
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(e)) {
    const name = calleeName(p);
    out.push(name && REQUEST_CALLEE.test(name) ? 'request' : name && LOG_CALLEE.test(name) ? 'inert' : 'other');
    return;
  }
  // `client.request({ url: helper(), method: 'GET' })` / `{ url, headers }`
  if (
    ((ts.isPropertyAssignment(p) && p.initializer === e) || ts.isShorthandPropertyAssignment(p)) &&
    ts.isObjectLiteralExpression(p.parent) &&
    isRequestConfig(p.parent)
  ) {
    out.push('request');
    return;
  }
  if (ts.isVariableDeclaration(p) && p.initializer === e && ts.isIdentifier(p.name)) {
    const refs = referencesOf(p);
    if (refs.length === 0) out.push('inert'); // computed and dropped
    for (const ref of refs) usesOf(ref, callSites, depth + 1, seenFns, out);
    return;
  }
  const returning = ts.isReturnStatement(p) ? p : ts.isArrowFunction(p) && p.body === e ? p : null;
  if (returning) {
    let fn: ts.Node | undefined = returning;
    while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
    const name = fn ? functionName(fn) : null;
    const sites = name ? callSites.get(name) ?? [] : [];
    if (!name || sites.length === 0 || seenFns.has(name)) {
      out.push('other');
      return;
    }
    seenFns.add(name);
    for (const site of sites) usesOf(site, callSites, depth + 1, seenFns, out);
    return;
  }
  out.push('other');
}

/** True when a URL-named helper only ever builds a request target. */
function isFetchHelper(name: string, callSites: Map<string, ts.CallExpression[]>): boolean {
  const uses: Use[] = [];
  for (const site of callSites.get(name) ?? []) usesOf(site, callSites, 0, new Set([name]), uses);
  return uses.includes('request') && uses.every((u) => u !== 'other');
}

/** `{ url, method: 'POST' }` or an object handed straight to `client.get/post/…`. */
function isRequestConfig(literal: ts.ObjectLiteralExpression): boolean {
  for (const prop of literal.properties) {
    if (prop.name && REQUEST_CONFIG_KEYS.has(prop.name.getText().replace(/['"]/g, ''))) return true;
  }
  let e: ts.Node = literal;
  while (ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent)) e = e.parent;
  const p = e.parent;
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(e as ts.Expression)) {
    const name = calleeName(p);
    return !!name && REQUEST_CALLEE.test(name);
  }
  return false;
}

export function scanPlugin(
  plugin: string,
  files: Array<{ file: string; text: string }>,
): ScanResult {
  const sources = files.map((f) =>
    ts.createSourceFile(f.file, f.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  );
  const index = indexPlugin(sources);
  const callSites = indexCallSites(sources, index);
  const findings: JobUrlFinding[] = [];
  let assignments = 0;
  let recordLinks = 0;
  let urlHelpers = 0;
  let fetchHelpers = 0;

  const report = (at: ts.Node, field: string, value: ts.Expression): void => {
    const sf = at.getSourceFile();
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

  for (const sf of sources) {
    const check = (at: ts.Node, field: string, value: ts.Expression | undefined): void => {
      if (!value) return;
      assignments += 1;
      report(at, field, value);
    };
    const checkRecord = (at: ts.Node, key: string, value: ts.Expression): void => {
      recordLinks += 1;
      report(at, `record ${key}`, value);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node)) {
        const key = node.name.getText().replace(/['"]/g, '');
        if (LINK_FIELDS.has(key)) check(node, key, node.initializer);
        else if (RECORD_LINK_KEY.test(key) && !isRequestConfig(node.parent)) {
          checkRecord(node, key, node.initializer);
        }
      } else if (ts.isShorthandPropertyAssignment(node)) {
        // `{ jobUrl }` is judged at its `const jobUrl`; `{ url }` is a record link
        if (RECORD_LINK_KEY.test(node.name.text) && !isRequestConfig(node.parent)) {
          checkRecord(node, node.name.text, node.name);
        }
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
        else if (key && ts.isPropertyAccessExpression(left) && RECORD_LINK_KEY.test(key)) {
          checkRecord(node, key, node.right);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // URL-named helpers: everything they can return, wherever the result goes —
  // unless every caller only fetches it.
  for (const [name, fns] of index.functions) {
    if (!URL_HELPER_NAME.test(name)) continue;
    if (isFetchHelper(name, callSites)) {
      fetchHelpers += 1;
      continue;
    }
    urlHelpers += 1;
    for (const fn of fns) {
      for (const ret of returnsOf(fn)) report(ret, `helper ${name}()`, ret);
    }
  }

  return { findings, assignments, recordLinks, urlHelpers, fetchHelpers };
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
  const total: ScanResult & { plugins: number } = {
    findings: [],
    assignments: 0,
    recordLinks: 0,
    urlHelpers: 0,
    fetchHelpers: 0,
    plugins: 0,
  };
  for (const plugin of fs.readdirSync(PLUGINS_DIR)) {
    const src = path.join(PLUGINS_DIR, plugin, 'src');
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) continue;
    const files = listTs(src).map((file) => ({
      file: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
      text: fs.readFileSync(file, 'utf8'),
    }));
    if (!files.some((f) => /\b(?:jobUrl|jobUrlDirect|applyUrl)\b/.test(f.text))) continue;
    total.plugins += 1;
    const result = scanPlugin(plugin, files);
    total.findings.push(...result.findings);
    total.assignments += result.assignments;
    total.recordLinks += result.recordLinks;
    total.urlHelpers += result.urlHelpers;
    total.fetchHelpers += result.fetchHelpers;
  }
  return total;
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

    // ── Sinks 3 + 4 (Spec 1751 T11): links built by a helper into a record ──

    it('follows a helper-built link stored in a record and copied later (mutant M7 shape)', () => {
      const findings = scanSnippet(`
        class S {
          private buildJobUrl(tenant: string, id: string): string {
            return \`https://api.acme.com/v1/jobs/\${id}\`;
          }
          private normalise(feed: any, tenant: string) {
            return { jobId: feed.id, url: feed.url ?? this.buildJobUrl(tenant, feed.id) };
          }
          private toPost(job: any) {
            const jobUrl = job.url; // a parameter: invisible to sinks 1-2
            return { jobUrl, applyUrl: jobUrl };
          }
        }`);
      expect(findings.map((f) => f.field).sort()).toEqual(['helper buildJobUrl()', 'record url']);
    });

    it('follows an arrow helper from another file into a shorthand { url } (not URL-named)', () => {
      const findings = scanSnippet(
        `import { vacancyPage } from './c';
         function ref(token: string) {
           const url = vacancyPage(token);
           return { url, token };
         }`,
        [{ file: 'c.ts', text: 'export const vacancyPage = (t: string): string => `https://api.acme.com/vacancies/${t}`;' }],
      );
      expect(findings.map((f) => f.field)).toEqual(['record url']);
    });

    it('judges a URL-named helper wherever its result goes — a template kept in a Map or a Record', () => {
      const findings = scanSnippet(`
        const PAGES = new Map<string, string>([
          ['en', 'https://werken.acme.nl/en/job/{id}'],
          ['nl', 'https://api.acme.nl/v1/vacatures/{id}'],
        ]);
        const APPLY: Record<string, string> = { en: 'https://acme.com/apply/{id}', nl: 'https://acme.nl/api/apply/{id}' };
        function jobUrlFor(lang: string, id: string) { return (PAGES.get(lang) ?? '').replace('{id}', id); }
        const getApplyUrl = (lang: string, id: string) => APPLY[lang].replace('{id}', id);
        function map(id: string) { return { detailPage: jobUrlFor('nl', id), applyPage: getApplyUrl('nl', id) }; }`);
      expect(findings.map((f) => f.field).sort()).toEqual(['helper getApplyUrl()', 'helper jobUrlFor()']);
    });

    it('a URL-named helper that is fetched AND stored for people is still a link helper', () => {
      const findings = scanSnippet(`
        class S {
          private pageUrl(id: string) { return \`https://api.acme.com/jobs/\${id}\`; }
          async map(client: any, id: string) {
            const url = this.pageUrl(id);
            await client.get(url);
            return { title: 'x', page: url };
          }
        }`);
      expect(findings.map((f) => f.field)).toEqual(['helper pageUrl()']);
    });

    it('does not flag fetch targets: request-only helpers, request configs, logs and truth tests', () => {
      const result = scanPlugin('fixture', [{
        file: 'fixture.service.ts',
        text: `
        const API = 'https://api.acme.com/v1';
        function listUrl(slug: string, page: number) { return \`\${API}/boards/\${slug}/jobs?page=\${page}\`; }
        class S {
          private detailUrl(id: string) { return \`\${API}/jobs/\${id}.json\`; }
          private baseUrl() { return 'https://api.acme.com/v1'; }
          private searchUrl(q: string) { return \`\${this.baseUrl()}/search?q=\${q}\`; }
          private feedUrl = (p: number) => \`\${API}/feed?page=\${p}\`;
          async run(client: any, slug: string, id: string) {
            let url: string | null = listUrl(slug, 1);
            while (url && url.length) {
              this.logger.log(\`GET \${url}\`);
              const r = await client.get(url);
              url = r.data.next ?? null;
            }
            const d = await this.fetchJson(client, new URL(this.detailUrl(id)).toString());
            await client.request({ url: this.searchUrl('x'), method: 'GET' });
            const u = this.feedUrl(2);
            await client.post(u, { url: \`\${API}/jobs\`, query: '{}' });
            return { jobUrl: \`https://careers.acme.com/jobs/\${id}\`, title: d.title };
          }
        }`,
      }]);
      expect(result.findings).toEqual([]);
      // five URL-named helpers exempted as fetch helpers, none judged as links
      expect(result.fetchHelpers).toBe(5);
      expect(result.urlHelpers).toBe(0);
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
      // 2026-09-25: 1,165 plugins, 1,520 link assignments, 197 record links,
      // 348 URL-named helpers judged as links, 93 exempted as fetch helpers.
      expect(result.plugins).toBeGreaterThan(1000);
      expect(result.assignments).toBeGreaterThan(1400);
      expect(result.recordLinks).toBeGreaterThan(150);
      expect(result.urlHelpers).toBeGreaterThan(300);
      expect(result.fetchHelpers).toBeGreaterThan(60);
    });

    it('no plugin wires an API URL or API field into a link field, a record url/link/href or a URL-named helper', () => {
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
