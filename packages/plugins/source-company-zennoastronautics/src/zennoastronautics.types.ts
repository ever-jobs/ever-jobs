/** One span inside a portable-text block's `children`. */
export interface ZennoPortableTextSpan {
  _key?: string;
  _type?: string;
  marks?: string[];
  text?: string;
}

/** One `markDefs` entry — annotation targets (links). */
export interface ZennoPortableTextMarkDef {
  _key?: string;
  _type?: string;
  href?: string;
}

/** One portable-text block inside a job's `text` array. */
export interface ZennoPortableTextBlock {
  style?: string | null;
  listItem?: string | null;
  children?: ZennoPortableTextSpan[];
  markDefs?: ZennoPortableTextMarkDef[];
}

/** One job object in the Sanity `result` array. */
export interface ZennoJobEntry {
  title?: string;
  slug?: { _type?: string; current?: string };
  location?: string;
  type?: string | null;
  compensation?: string | null;
  text?: ZennoPortableTextBlock[];
}

/** Top-level Sanity query response. */
export interface ZennoSanityResponse {
  result?: ZennoJobEntry[] | null;
}
