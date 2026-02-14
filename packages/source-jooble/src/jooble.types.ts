/**
 * Shape of the response from the Jooble API.
 */
export interface JoobleResponse {
  totalCount: number;
  jobs: JoobleJob[];
}

/**
 * Shape of a single job returned by the Jooble API.
 */
export interface JoobleJob {
  title: string;
  location: string;
  snippet: string;
  salary: string;
  source: string;
  type: string;
  link: string;
  company: string;
  updated: string;
  id: string;
}
