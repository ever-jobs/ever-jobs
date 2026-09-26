/** Shapes inside the Inertia `data-page` JSON prop of an octbr.ai board. */

export interface OctbrAiListJob {
  id: number;
  title: string;
  slug: string;
  url: string;
  location: string | null;
  location_type: string | null;
  employment_type: string | null;
  employment_type_label: string | null;
  posted_date?: string | null;
}

export interface OctbrAiDepartmentGroup {
  department: string;
  jobs: OctbrAiListJob[];
}

export interface OctbrAiDetailJob {
  description?: string | null;
  responsibilities?: string | null;
  requirements?: string | null;
  posted_date?: string | null;
  department?: string | null;
}
