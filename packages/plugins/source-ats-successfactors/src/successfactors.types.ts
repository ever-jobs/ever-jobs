/**
 * TypeScript interfaces for SAP SuccessFactors OData API responses.
 */

export interface SfJobPosting {
  jobReqId?: string | null;
  jobTitle?: string | null;
  jobDescription?: string | null;
  locationObj?: {
    city?: string | null;
    state?: string | null;
    country?: string | null;
  } | null;
  locationObjlist?: Array<{
    city?: string | null;
    state?: string | null;
    country?: string | null;
  }> | null;
  department?: string | null;
  division?: string | null;
  postingStartDate?: string | null;
  postingEndDate?: string | null;
  jobType?: string | null;
  employmentType?: string | null;
  companyName?: string | null;
  externalJobUrl?: string | null;
  formattedJobTitle?: string | null;
}

export interface SfODataResponse {
  d?: {
    results?: SfJobPosting[];
    __count?: string;
    __next?: string;
  };
}

/**
 * A job tile enumerated from a Career Site Builder (CSB) `tile-search-results`
 * list page. Carries only what the list exposes; the rest comes from the detail
 * page microdata.
 */
export interface SfCsbListItem {
  jobId: string;
  title: string;
  jobUrl: string;
}

/**
 * schema.org `JobPosting` microdata fields extracted from a CSB detail page.
 */
export interface SfCsbDetail {
  title?: string | null;
  descriptionHtml?: string | null;
  datePosted?: string | null;
  validThrough?: string | null;
  hiringOrganization?: string | null;
  industry?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postalCode?: string | null;
}
