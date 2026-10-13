/**
 * TypeScript interfaces for Workday API responses.
 */

export interface WorkdayJobListItem {
  title?: string | null;
  externalPath?: string | null;
  locationsText?: string | null;
  postedOn?: string | null;
  remoteType?: string | null;
  bulletFields?: string[] | null;
  subtitles?: Array<{
    instances?: Array<{ text?: string }>;
  }> | null;
}

export interface WorkdayJobDetail {
  jobPostingInfo?: {
    title?: string | null;
    jobDescription?: string | null;
    location?: string | null;
    postedOn?: string | null;
    jobReqId?: string | null;
    externalUrl?: string | null;
    startDate?: string | null;
    additionalLocations?: string[] | null;
    jobFamily?: Array<{ name?: string }> | null;
    timeType?: string | null;
    workerSubType?: string | null;
    remoteType?: string | null;
    country?: { descriptor?: string | null; id?: string | null } | null;
    jobRequisitionLocation?: {
      descriptor?: string | null;
      country?: {
        descriptor?: string | null;
        id?: string | null;
        alpha2Code?: string | null;
      } | null;
    } | null;
  } | null;
  hiringOrganization?: {
    name?: string | null;
    url?: string | null;
  } | null;
}

export interface WorkdayFacetValue {
  descriptor?: string | null;
  id?: string | null;
  count?: number;
  /** Present when the entry is itself a nested facet inside a facet group. */
  facetParameter?: string | null;
  values?: WorkdayFacetValue[] | null;
}

export interface WorkdayFacet {
  facetParameter?: string | null;
  descriptor?: string | null;
  values?: WorkdayFacetValue[] | null;
}

export interface WorkdaySearchResponse {
  total?: number;
  jobPostings?: WorkdayJobListItem[];
  facets?: WorkdayFacet[] | null;
}
