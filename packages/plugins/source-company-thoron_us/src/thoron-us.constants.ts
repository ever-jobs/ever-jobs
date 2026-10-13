export const THORON_US_COMPANY_NAME = 'Thoron';
export const THORON_US_ORIGIN = 'https://www.thoron.us';
export const THORON_US_CAREERS_URL = `${THORON_US_ORIGIN}/careers`;
export const THORON_US_DEFAULT_TIMEOUT_SECONDS = 30;
/** App bundle referenced by the SPA shell. */
export const THORON_US_MAIN_JS_RE = /src="(\/assets\/index-[0-9a-z]+\.js)"/i;
/**
 * Start of the embedded jobs array: `=[{id:N,title:"…",department:"…",
 * location:"…",type:"` — the binding name is minified and the bundle ships
 * sibling `{…,title:"…"}` literals (icon/feature arrays), so the anchor
 * must match the full job-entry field run.
 */
export const THORON_US_JOBS_ARRAY_RE =
  /=\s*\[\{id:\d+,title:"[^"]*",department:"[^"]*",location:"[^"]*",type:"/;
