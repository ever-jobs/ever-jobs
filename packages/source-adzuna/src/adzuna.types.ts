/**
 * Top-level response from the Adzuna Search API.
 */
export interface AdzunaResponse {
  results: AdzunaJob[];
  count: number;
  mean: number;
}

/**
 * A single job listing from Adzuna.
 */
export interface AdzunaJob {
  id: string;
  title: string;
  description: string;
  redirect_url: string;
  created: string;
  company: {
    display_name: string;
  };
  location: {
    display_name: string;
    area: string[];
  };
  salary_min: number;
  salary_max: number;
  salary_is_predicted: string;
  contract_type: string;
  contract_time: string;
  category: {
    label: string;
    tag: string;
  };
  latitude: number;
  longitude: number;
}
