/** `/api/careers/listings` payload shape (first-party careers API). */
export interface BuildnebulaLocation {
  city?: string;
  state?: string;
  country?: string;
  workplace_type?: string;
}

export interface BuildnebulaCompensation {
  min?: number;
  max?: number;
  currency?: string;
  period?: string;
}

export interface BuildnebulaDescriptionSections {
  prose?: string;
  responsibilities?: string[];
  requirements?: string[];
  nice_to_have?: string[];
}

export interface BuildnebulaJob {
  title?: string;
  team?: string;
  track?: string | null;
  department?: string;
  employment_type?: string;
  locations?: BuildnebulaLocation[];
  compensation?: BuildnebulaCompensation;
  description_sections?: BuildnebulaDescriptionSections;
  closing_paragraphs?: string[];
  benefits?: string[];
}

export interface BuildnebulaListing {
  listing_id?: string;
  slug?: string;
  status?: string;
  takedown?: boolean;
  visibility?: string;
  published_at?: string;
  compensation_line?: string;
  equity_sentence?: string;
  job?: BuildnebulaJob;
}

export interface BuildnebulaListingsResponse {
  items?: BuildnebulaListing[];
}
