/** Minimal shape of a WordPress REST `pages` entry (only fields we read). */
export interface WpPage {
  id?: number;
  link?: string;
  content?: { rendered?: string };
}

/** A single role parsed out of the Divi careers markup. */
export interface NanoRole {
  title: string;
  subtitle: string | null;
  body: string | null;
  employmentType: string | null;
  location: string | null;
  salaryText: string | null;
}
