/** Shapes of the Nodi public jobs API (`api.nodi.global`). */

export interface NodiGlobalJobOffer {
  id: string;
  title: string | null;
  company?: string | null;
  location: string | null;
  department: string | null;
  type: string | null;
  modality: string | null;
  seniority: string | null;
  min_salary: number | null;
  max_salary: number | null;
  currency: string | null;
  frequency: string | null;
  description: string | null;
  created_at: string | null;
  magic_link: string | null;
  status: string | null;
}

export interface NodiGlobalCompany {
  company_name: string | null;
  website: string | null;
  industry: string | null;
  company_description: string | null;
}
