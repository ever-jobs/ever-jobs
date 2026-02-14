/**
 * Shape of a single job object returned by the RemoteOK API.
 * The API returns a JSON array where the first element is a metadata
 * object (with a "legal" key) and the remaining elements are job objects.
 */
export interface RemoteOkJob {
  slug: string;
  id: string;
  epoch: number;
  date: string;
  company: string;
  company_logo: string;
  position: string;
  tags: string[];
  description: string;
  location: string;
  apply_url: string;
  salary_min: number;
  salary_max: number;
  url: string;
}
