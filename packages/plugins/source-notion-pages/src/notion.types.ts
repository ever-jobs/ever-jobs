/**
 * Minimal shapes for the public Notion `loadPageChunk` response. Only the
 * fields this plugin reads are modelled; everything else is ignored.
 */

/** A rich-text run: `[plainText, annotations?]`. We only read the plain text. */
export type NotionTextSegment = [string, ...unknown[]];

export interface NotionBlockValue {
  id: string;
  type?: string;
  properties?: {
    title?: NotionTextSegment[];
    [key: string]: unknown;
  };
  content?: string[];
  created_time?: number;
  last_edited_time?: number;
}

/**
 * A block record. Notion has shipped two envelope shapes over time — a flat
 * `{ role, value }` and a nested `{ value: { role, value } }`. `unwrapBlock`
 * descends either to the real block, so callers stay shape-agnostic.
 */
export interface NotionBlockRecord {
  role?: string;
  value?: NotionBlockValue | NotionBlockRecord;
}

export interface NotionLoadPageChunkResponse {
  recordMap?: {
    block?: Record<string, NotionBlockRecord>;
  };
}

/** A role sub-page discovered under the board's root page. */
export interface NotionRole {
  id: string;
  title: string;
}

/** Fields parsed from a role sub-page's blocks. */
export interface NotionRoleDetail {
  description: string | null;
  locationText: string | null;
  createdTime: number | null;
}
