/**
 * Shape of a single job returned by the Himalayas API.
 */
export interface HimalayasJob {
  title: string;
  excerpt: string;
  companyName: string;
  companyLogo: string;
  employmentType: string;
  minSalary: number;
  maxSalary: number;
  seniority: string[];
  currency: string;
  locationRestrictions: string[];
  timezoneRestrictions: string[];
  categories: string[];
  parentCategories: string[];
  description: string;
  pubDate: number;
  expiryDate: number;
  applicationLink: string;
  guid: string;
}

/**
 * Top-level response envelope from the Himalayas API.
 */
export interface HimalayasApiResponse {
  jobs: HimalayasJob[];
  totalCount: number;
  offset: number;
  limit: number;
}
