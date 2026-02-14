/**
 * Shape of the search response from the Reed API.
 */
export interface ReedSearchResponse {
  results: ReedJob[];
  totalResults: number;
  ambiguousLocations?: string[];
}

/**
 * Shape of a single job returned by the Reed API.
 */
export interface ReedJob {
  jobId: number;
  employerId: number;
  employerName: string;
  employerProfileId: number | null;
  employerProfileName: string | null;
  jobTitle: string;
  locationName: string;
  minimumSalary: number | null;
  maximumSalary: number | null;
  currency: string | null;
  expirationDate: string;
  date: string;
  jobDescription: string;
  applications: number;
  jobUrl: string;
}
