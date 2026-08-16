/**
 * Constants for the True Metal Supply (truemetalsupply.com) careers scraper.
 *
 * True Metal Supply has no third-party ATS. Its careers page is a custom **Wix**
 * (Thunderbolt) site. The `/careers` page renders a "Job Descriptions" group of
 * buttons (`wixui.StylableButton`, `aria-haspopup="dialog"`); clicking a button
 * opens a Wix popup/lightbox that holds that role's full job description (About
 * Us / Position Overview / Key Responsibilities / Requirements / Why Join Us).
 *
 * The openings are client-rendered — the initial HTML carries the button labels
 * but not the description bodies, and the popups are not standalone routes (their
 * `copy-of-*` slugs soft-404 when fetched directly). So the roles are harvested
 * with a headless browser (the shared `BrowserPool`): open `/careers`, click each
 * dialog trigger, and read the rendered popup. A job dialog is distinguished from
 * unrelated dialogs (e.g. "Color Chart & SRI Values") by its job-description
 * section markers.
 *
 * Field availability (verified): only **title** and **description** are stated.
 * There is no per-role compensation, employment type, posted date, or apply link
 * (applying is a single page-level Wix form shared by all roles). A role's
 * location is only present when the employer prefixes it into the title (e.g.
 * "Asheville Facility Manager") — that title-prefix city is the sole location
 * signal used; the corporate HQ is never synthesized.
 *
 * Single-company plugin: the domain, URLs, and company name are baked in.
 */

/** Canonical company display name (the brand, not the domain). */
export const TRUEMETALSUPPLY_COMPANY_NAME = 'True Metal Supply';

/** Site origin — the `www` host the site is served from. */
export const TRUEMETALSUPPLY_ORIGIN = 'https://www.truemetalsupply.com';

/** Public careers page — the headless navigation target and companyUrl. */
export const TRUEMETALSUPPLY_CAREERS_URL = `${TRUEMETALSUPPLY_ORIGIN}/careers`;

/** Selector for the Wix dialog trigger buttons on the careers page. */
export const TRUEMETALSUPPLY_DIALOG_TRIGGER_SELECTOR =
  '[aria-haspopup="dialog"]';

/** Selector for the opened Wix popup/lightbox that holds a role's JD. */
export const TRUEMETALSUPPLY_DIALOG_SELECTOR = '[role="dialog"]';

/**
 * Job-description section markers. A dialog is treated as a real opening only
 * when its text contains at least `TRUEMETALSUPPLY_JD_MARKER_MIN` of these — this
 * filters out non-job dialogs (e.g. "Color Chart & SRI Values") without pinning
 * a fixed list of role titles (roles change).
 */
export const TRUEMETALSUPPLY_JD_MARKERS: readonly string[] = [
  'about us',
  'about the role',
  'position overview',
  'key responsibilities',
  'responsibilities',
  'requirements',
  'preferred qualifications',
  'qualifications',
  'why join us',
];

/** Minimum number of JD markers a dialog must contain to count as an opening. */
export const TRUEMETALSUPPLY_JD_MARKER_MIN = 2;

/**
 * The company's known facility cities. Location is derived only from a title
 * whose leading token matches one of these (e.g. "Asheville Facility Manager" →
 * Asheville). Grounded in the two facility addresses the site itself publishes
 * (Knoxville, TN and Asheville, NC). No generic city gazetteer is used, so a
 * non-location leading word (e.g. "Project", "Customer") never becomes a city.
 */
export const TRUEMETALSUPPLY_FACILITY_CITIES: readonly string[] = [
  'Knoxville',
  'Asheville',
];

/** Default number of roles returned when the caller does not specify. */
export const TRUEMETALSUPPLY_DEFAULT_RESULTS = 50;

/** Default per-request/navigation timeout (seconds). */
export const TRUEMETALSUPPLY_DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Readiness-wait timeout (seconds) for the dialog-trigger `waitForSelector`,
 * kept well below the navigation timeout. The triggers are attached within
 * ~0.1 s; this only guards against a genuinely absent trigger group.
 */
export const TRUEMETALSUPPLY_READY_TIMEOUT_SECONDS = 12;

/**
 * Per-dialog visibility timeout (ms). A trigger's popup opens within the settle
 * window; bounding this stops a single non-opening dialog from serializing into
 * the full navigation timeout when many triggers are present.
 */
export const TRUEMETALSUPPLY_DIALOG_VISIBLE_TIMEOUT_MS = 6000;

/** Milliseconds to wait after opening/closing a dialog for it to settle. */
export const TRUEMETALSUPPLY_DIALOG_SETTLE_MS = 600;

/**
 * How many times to click a trigger while trying to open its popup. The very
 * first Wix popup click of a page can land before Thunderbolt has wired the
 * popup handler, so it opens nothing; a second click (after re-settling) then
 * succeeds. Without this the first real role on the board is silently dropped.
 */
export const TRUEMETALSUPPLY_DIALOG_OPEN_ATTEMPTS = 2;
