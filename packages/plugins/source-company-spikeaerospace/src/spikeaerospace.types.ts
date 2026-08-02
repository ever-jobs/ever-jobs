/** Minimal shape of a WordPress REST `categories` entry (only fields we read). */
export interface WpCategory {
  id?: number;
  slug?: string;
}

/** Minimal shape of a WordPress REST `posts` entry (only fields we read). */
export interface WpPost {
  id?: number;
  slug?: string;
  link?: string;
  date?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
}

/** A single open role parsed out of a Current Openings post. */
export interface SpikeRole {
  /** Post slug (stable id source). */
  slug: string;
  /** Absolute role page URL (jobUrl). */
  jobUrl: string;
  /** Role title (decoded). */
  title: string;
  /** Rendered body as markdown. */
  description: string | null;
  /** Publish date as a `YYYY-MM-DD` calendar day. */
  datePosted: string | null;
}
