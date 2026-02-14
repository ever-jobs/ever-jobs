/**
 * Shape of a single job returned by the Jobicy v2 API.
 */
export interface JobicyJob {
  id: number;
  url: string;
  jobSlug: string;
  jobTitle: string;
  companyName: string;
  companyLogo: string;
  jobIndustry: string[];
  jobType: string[];
  jobGeo: string;
  jobLevel: string;
  jobExcerpt: string;
  jobDescription: string;
  pubDate: string;
  annualSalaryMin?: number | null;
  annualSalaryMax?: number | null;
  salaryCurrency?: string | null;
}

/**
 * Top-level response envelope from the Jobicy API.
 */
export interface JobicyApiResponse {
  jobs: JobicyJob[];
}
