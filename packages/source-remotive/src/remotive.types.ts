/**
 * Shape of the Remotive API response.
 */
export interface RemotiveApiResponse {
  jobs: RemotiveJob[];
}

/**
 * Shape of a single job object returned by the Remotive API.
 */
export interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  company_logo: string;
  company_logo_url: string;
  category: string;
  tags: string[];
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
}
