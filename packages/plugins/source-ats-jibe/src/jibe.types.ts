/**
 * Shapes of the Jibe `/api/jobs` response envelope and its `jobs[].data` entries.
 * Fields beyond these exist on the wire; only the ones mapped into JobPostDto
 * (or useful for identity) are typed here.
 */

export interface JibeJobData {
  slug?: string;
  req_id?: string;
  title?: string;
  description?: string;
  apply_url?: string;
  city?: string;
  state?: string;
  country?: string;
  country_code?: string;
  full_location?: string;
  short_location?: string;
  category?: string | string[];
  categories?: string | string[];
  employment_type?: string;
  posted_date?: string;
  create_date?: string;
  update_date?: string;
  hiring_organization?: string;
  location_type?: string;
  latitude?: string | number;
  longitude?: string | number;
  multipleLocations?: boolean | string;
}

export interface JibeJobsPage {
  jobs?: Array<{ data?: JibeJobData }>;
  totalCount?: number;
  count?: number;
}

/** Resolved addressing for one Jibe tenant. */
export interface JibeTarget {
  /** Scheme + host the API lives on, e.g. `https://careers.rivian.com`. */
  origin: string;
  /** Site mount base for detail URLs — origin + mount path (may equal origin). */
  detailBase: string;
  /** Host label for ids/company-name fallback, e.g. `careers.rivian.com`. */
  host: string;
}
