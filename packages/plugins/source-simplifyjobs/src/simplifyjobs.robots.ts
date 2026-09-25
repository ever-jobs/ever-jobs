/**
 * Minimal robots.txt support (RFC 9309) for the feed host (Spec 1694).
 *
 * The host served no robots.txt when this source was added (404, which
 * allows everything). The plugin still checks it before any feed request, so
 * a later policy is honoured without a code change.
 */

export interface RobotsRule {
  allow: boolean;
  /** Path pattern; `*` matches any run of characters, a trailing `$` anchors the end. */
  pattern: string;
}

/** robots.txt forbids the path we were about to fetch. */
export class RobotsDisallowedError extends Error {
  constructor(readonly path: string) {
    super(`simplifyjobs: robots.txt disallows ${path}`);
    this.name = 'RobotsDisallowedError';
  }
}

/** robots.txt could not be read (5xx or network) and no earlier copy is usable. */
export class RobotsUnreachableError extends Error {
  constructor(readonly causeMessage: string) {
    super(`simplifyjobs: robots.txt unreachable (${causeMessage}); feed not requested`);
    this.name = 'RobotsUnreachableError';
  }
}

interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

/**
 * The rules that apply to `productToken`: every group naming it
 * (case-insensitive, `EverJobs/1.0` matches `everjobs`), else every `*` group.
 * Empty means everything is allowed.
 */
export function parseRobotsTxt(text: string, productToken: string): RobotsRule[] {
  const token = productToken.toLowerCase();
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || (key !== 'allow' && key !== 'disallow')) continue;
    // An empty `Disallow:` allows everything; it adds no rule.
    if (!value) continue;
    current.rules.push({ allow: key === 'allow', pattern: value });
  }

  const matchesToken = (agent: string): boolean => {
    const name = agent.split('/')[0].trim();
    return name !== '*' && name !== '' && name === token;
  };
  const named = groups.filter((g) => g.agents.some(matchesToken));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

/** Whether a rule pattern matches a path (prefix match, `*` wildcards, optional `$` anchor). */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const pieces = body.split('*');
  let pos = 0;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (i === 0) {
      if (!path.startsWith(piece)) return false;
      pos = piece.length;
      continue;
    }
    if (i === pieces.length - 1 && anchored) {
      return path.length - piece.length >= pos && path.endsWith(piece);
    }
    const found = path.indexOf(piece, pos);
    if (found === -1) return false;
    pos = found + piece.length;
  }
  return !anchored || pos === path.length;
}

/**
 * RFC 9309 §2.2.2: the longest matching pattern (in characters written, `*`
 * and `$` included) wins; on a tie `allow` wins; no match allows.
 * `/robots.txt` itself is always allowed.
 */
export function robotsAllows(rules: readonly RobotsRule[], path: string): boolean {
  if (path === '/robots.txt') return true;
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    if (
      best === null ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best === null || best.allow;
}
