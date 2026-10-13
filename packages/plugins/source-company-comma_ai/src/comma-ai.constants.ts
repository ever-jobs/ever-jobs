export const COMMA_AI_COMPANY_NAME = 'comma';
export const COMMA_AI_ORIGIN = 'https://comma.ai';
export const COMMA_AI_CAREERS_URL = `${COMMA_AI_ORIGIN}/jobs`;
export const COMMA_AI_DEFAULT_TIMEOUT_SECONDS = 30;
/**
 * SvelteKit node chunks referenced by the careers page
 * (`import("/_app/immutable/nodes/4.ABC123.js")` + modulepreload links).
 * Group 1 is the chunk path; hashes rotate on every deploy.
 */
export const COMMA_AI_NODE_CHUNK_RE =
  /["'](\/_app\/immutable\/nodes\/[^"']+\.js)["']/g;
/** Most chunks to fetch while looking for the jobs array. */
export const COMMA_AI_MAX_CHUNKS = 6;
/**
 * Start of the embedded jobs array: `=[{title:"…",` — the binding name is
 * minified. Entries look like
 * `{title:"…",team:"…",location:"…",description:`…`,qualifications:[…],
 * howToApply:'…'}`; require a `qualifications:` key so a stray
 * `[{title:…}]` literal can't win.
 */
export const COMMA_AI_JOBS_ARRAY_RE = /=\s*\[\{title:"/;
export const COMMA_AI_QUALIFICATIONS_RE = /qualifications:\s*\[/;
/** Strip the site's on-site prefixes before location parsing. */
export const COMMA_AI_ONSITE_PREFIX_RE = /^\s*(?:paid\s+and\s+)?on-site\s+in\s+/i;
