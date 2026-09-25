/** One entry in the `/api/careers` JSON array. */
export interface PowerUsCareerEntry {
  title?: string;
  department?: string;
  location?: string;
  type?: string;
  summary?: string;
  responsibilities?: string[];
  qualifications?: string[];
  preferredSkills?: string[];
  linkedInUrl?: string;
}
