export const REVOY_COMPANY_NAME = 'Revoy';
export const REVOY_ORIGIN = 'https://www.revoy.com';
export const REVOY_CAREERS_URL = `${REVOY_ORIGIN}/join-the-team`;
export const REVOY_DEFAULT_TIMEOUT_SECONDS = 30;

/** Role rows: `<a class="link-12" href="…/document/d/{id}/edit">{title}</a> — {place}`. */
export const REVOY_LINK_SELECTOR = 'a[href*="/document/d/"]';
export const REVOY_DOC_ID_RE = /\/document\/d\/([A-Za-z0-9_-]+)/;
export const REVOY_DOC_EXPORT = (docId: string): string =>
  `https://docs.google.com/document/d/${docId}/export?format=txt`;

/** ` — City, ST` trailing the link in the row's parent text. */
export const REVOY_ROW_LOCATION_RE = /\s[—–-]\s+(.+)$/;

/** Labeled doc headers (doc 2 uses `Location:`, doc 1 uses `LOCATION`). */
export const REVOY_DOC_LOCATION_RE = /^\s*(?:Location|LOCATION)\s*[:]\s*(.+?)\s*$/m;
export const REVOY_DOC_LOCATION_BLOCK_RE = /LOCATION\s+([A-Z][^\n]+?)\s*(?:\n|\t|$)/;
export const REVOY_DOC_DEPARTMENT_RE = /^\s*(?:Department|FUNCTION)\s*[:]\s*(.+?)\s*$/m;
export const REVOY_DOC_DEPARTMENT_BLOCK_RE = /FUNCTION\s+([^\n]+?)\s*(?:\n|\t|$)/;
export const REVOY_DOC_TYPE_RE = /^\s*Type\s*[:]\s*(.+?)\s*$/m;

export const REVOY_ONSITE_RE = /\(\s*(?:on[-\s]?site|onsite)\s*\)/i;
export const REVOY_REMOTE_RE = /\(\s*remote\s*\)/i;
export const REVOY_HYBRID_RE = /\(\s*hybrid\s*\)/i;
