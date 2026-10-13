export const XGSENERGY_COMPANY_NAME = 'XGS Energy';
export const XGSENERGY_ORIGIN = 'https://www.xgsenergy.com';
export const XGSENERGY_CAREERS_URL = `${XGSENERGY_ORIGIN}/careers/`;
export const XGSENERGY_DEFAULT_TIMEOUT_SECONDS = 30;

/** One accordion block per role. */
export const XGSENERGY_ITEM_SELECTOR = 'div.elementor-accordion-item';
/** `"{title} Location {place}"` anchor: title text + `.acco-loc`/.acco-na` spans. */
export const XGSENERGY_TITLE_SELECTOR = 'a.elementor-accordion-title';
export const XGSENERGY_TITLE_LOC_MARKER = '.acco-loc';
export const XGSENERGY_TITLE_LOC_VALUE = '.acco-na';
/** Role body, sibling of the tab title inside the same item. */
export const XGSENERGY_CONTENT_SELECTOR = '.elementor-tab-content';
/** `id="elementor-tab-title-NNNN"` on the tab — used only as a `jobUrl` anchor. */
export const XGSENERGY_TAB_ID_PREFIX = 'elementor-tab-title-';

export const XGSENERGY_HYBRID_RE = /^\s*hybrid\s*$/i;

export const XGSENERGY_CFEMAIL_ATTR = 'data-cfemail';
export const XGSENERGY_CFEMAIL_SELECTOR = '.__cf_email__';
export const XGSENERGY_CFEMAIL_HREF_RE = /email-protection#([0-9a-f]+)/i;
