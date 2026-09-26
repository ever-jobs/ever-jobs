/** One section of a role posting (`sections[]` entries in the bundle array). */
export interface FourEarthJobSection {
  heading: string;
  items: { label?: string; text: string }[];
}

/** One role entry from the Careers chunk's embedded jobs array. */
export interface FourEarthJobEntry {
  id: string;
  title: string;
  location: string;
  type: string;
  mission: string;
  roleIntro: string;
  roleSummary: string;
  rolePoints: string[];
  sections: FourEarthJobSection[];
  whySection: string;
}
