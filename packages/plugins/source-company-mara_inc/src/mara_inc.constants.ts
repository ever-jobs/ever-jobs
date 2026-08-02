/**
 * Mara (Mara Defense, mara.inc) — a custom Webflow careers site with no ATS.
 * The openings are server-rendered in the static `/career` HTML, so this is a
 * single-step plain-HTTP + Cheerio scrape — no headless browser and no JSON
 * API (the JSON-LD is only WebPage/BreadcrumbList; no JobPosting data).
 *
 * Each opening is a `.mr-job-content-box` card exposing: a large title
 * (`.mr-h4`), a small highlight chip (`.label-transparant`), a location + an
 * employment-type chip (`.label-location`), and an "apply now" button linking
 * to LinkedIn. There is no on-domain per-role page, no salary, no description
 * and no posted date. The apply link (LinkedIn) is carried but never fetched.
 *
 * The board template also renders a placeholder card whose apply button points
 * at `#` — only cards with a real LinkedIn apply URL are ingested.
 */
export const MARA_INC_COMPANY_NAME = 'Mara Defense';
export const MARA_INC_ORIGIN = 'https://mara.inc';
export const MARA_INC_CAREERS_URL = `${MARA_INC_ORIGIN}/career`;

/** Webflow card selectors (stable, human-authored class names). */
export const MARA_INC_CARD_SELECTOR = '.mr-job-content-box';
export const MARA_INC_TITLE_SELECTOR = '.mr-h4';
export const MARA_INC_HIGHLIGHT_SELECTOR = '.label-transparant';
export const MARA_INC_LABEL_SELECTOR = '.label-location';
export const MARA_INC_APPLY_SELECTOR = 'a[href*="linkedin.com/jobs"]';

export const MARA_INC_DEFAULT_RESULTS = 50;
export const MARA_INC_DEFAULT_TIMEOUT_SECONDS = 20;
