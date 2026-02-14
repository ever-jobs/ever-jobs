/**
 * TypeScript interfaces for Recruitee API responses.
 */

export interface RecruiteeResponse {
  offers: RecruiteeOffer[];
}

export interface RecruiteeOffer {
  id: number;
  title: string;
  slug: string;
  department: string | null;
  location: string | null;
  city: string | null;
  country: string | null;
  state: string | null;
  remote: boolean;
  description: string;
  created_at: string;
  careers_url: string;
  min_hours: number | null;
  max_hours: number | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
}
