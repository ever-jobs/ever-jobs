/** Minimal shapes for the Sanity Portable-Text + `career` documents we read. */

/** A span inside a Portable-Text block. */
export interface SanitySpan {
  _type?: string;
  text?: string;
}

/** A Portable-Text block (paragraph, heading, or list item). */
export interface SanityBlock {
  _type?: string;
  style?: string;
  listItem?: string;
  level?: number;
  children?: SanitySpan[];
}

/** An `extraSections[]` entry: a titled group of Portable-Text blocks. */
export interface SanityExtraSection {
  title?: string | null;
  content?: SanityBlock[];
}

/** A Cover `career` document, as projected by the GROQ query. */
export interface SanityCareer {
  _id?: string;
  title?: string;
  slug?: string | null;
  location?: string | null;
  type?: string | null;
  _createdAt?: string | null;
  _updatedAt?: string | null;
  overview?: SanityBlock[] | null;
  role?: SanityBlock[] | null;
  experience?: SanityBlock[] | null;
  extraSections?: SanityExtraSection[] | null;
  compensation?: SanityBlock[] | null;
}

/** The GROQ query result. */
export interface BuildcoverQueryResult {
  contactEmail?: string | null;
  careers?: SanityCareer[] | null;
}

/** The Sanity query API envelope. */
export interface SanityQueryResponse {
  result?: BuildcoverQueryResult | null;
}
