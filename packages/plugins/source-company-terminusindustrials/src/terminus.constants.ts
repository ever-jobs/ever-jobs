/**
 * Terminus Industrials (terminusindustrials.com) — a custom Next.js careers
 * site with no ATS. The full JD is server-rendered on `/careers` (SSR), so this
 * is a single-step plain-HTTP + Cheerio scrape — no headless browser and no
 * per-role detail fan-out (the JD is inline on the same page).
 *
 * Each role is a `Careers_card__*` block exposing: title (+ qualifier), badge
 * chips, a meta row (department / location / employment type), the JD sections
 * (Job Summary / Key Responsibilities / Desired Qualifications) in an inline
 * dropdown, an on-domain JD PDF, and a JS-only apply modal (no per-role apply
 * URL). No Indeed / third-party ATS anywhere.
 *
 * CSS-module class names are hashed (`Careers_card__cQ1y`), but the
 * `Careers_<name>__` prefix is stable across builds, so selectors match on that
 * prefix via `[class*="Careers_<name>__"]`.
 */
export const TERMINUS_COMPANY_NAME = 'Terminus Industrials';
export const TERMINUS_ORIGIN = 'https://www.terminusindustrials.com';
export const TERMINUS_CAREERS_URL = `${TERMINUS_ORIGIN}/careers`;

/** Stable CSS-module class prefixes (the trailing hash is build-specific). */
export const TERMINUS_CARD_CLASS = 'Careers_card__';
export const TERMINUS_CARD_TITLE_CLASS = 'Careers_cardTitle__';
export const TERMINUS_META_ITEM_CLASS = 'Careers_metaItem__';
export const TERMINUS_SECTION_CLASS = 'Careers_section__';
export const TERMINUS_DROPDOWN_INNER_CLASS = 'Careers_dropdownInner__';

export const TERMINUS_DEFAULT_RESULTS = 50;
export const TERMINUS_DEFAULT_TIMEOUT_SECONDS = 20;
