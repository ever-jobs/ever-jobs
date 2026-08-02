/**
 * TypeScript interfaces for JazzHR career board scraping.
 * The board HTML is parsed via cheerio; the detail page overlays the body.
 */

/** A row parsed from the board's desktop job table. */
export interface JazzHRJobListing {
  code: string;
  title: string;
  location: string | null;
  department: string | null;
  jobUrl: string;
}

/** Fields parsed from a job's detail page. */
export interface JazzHRJobDetail {
  description: string | null;
  employmentType: string | null;
  companyName: string | null;
}
