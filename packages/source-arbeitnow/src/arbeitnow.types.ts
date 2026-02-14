/**
 * Shape of a single job returned by the Arbeitnow API.
 */
export interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
}

/**
 * Top-level response envelope from the Arbeitnow API.
 */
export interface ArbeitnowApiResponse {
  data: ArbeitnowJob[];
  links: {
    next: string | null;
  };
  meta: Record<string, any>;
}
