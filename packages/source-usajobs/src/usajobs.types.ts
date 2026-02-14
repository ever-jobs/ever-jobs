/**
 * Top-level response from the USAJobs Search API.
 */
export interface UsaJobsResponse {
  SearchResult: {
    SearchResultCount: number;
    SearchResultCountAll: number;
    SearchResultItems: UsaJobsItem[];
  };
}

/**
 * A single search result item.
 */
export interface UsaJobsItem {
  MatchedObjectId: string;
  MatchedObjectDescriptor: UsaJobsDescriptor;
}

/**
 * The descriptor containing all job details.
 */
export interface UsaJobsDescriptor {
  PositionTitle: string;
  PositionURI: string;
  PositionID: string;
  OrganizationName: string;
  DepartmentName: string;
  PositionLocation: UsaJobsLocation[];
  PositionRemuneration: UsaJobsRemuneration[];
  PositionStartDate: string;
  PositionEndDate: string;
  PublicationStartDate: string;
  ApplicationCloseDate: string;
  QualificationSummary: string;
  UserArea: {
    Details: {
      JobSummary: string;
      MajorDuties: string[];
    };
  };
}

/**
 * Location entry in a USAJobs result.
 */
export interface UsaJobsLocation {
  LocationName: string;
  CountryCode: string;
  CityName: string;
  CountrySubDivisionCode: string;
}

/**
 * Remuneration / salary entry.
 */
export interface UsaJobsRemuneration {
  MinimumRange: string;
  MaximumRange: string;
  RateIntervalCode: string;
  Description: string;
}
