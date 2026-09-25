/** One role entry from the hiring chunk's embedded jobs array. */
export interface LabsActorJobEntry {
  id: string;
  title: string;
  team: string;
  location: string;
  type: string;
  summary: string;
  responsibilities: string[];
  requirements: string[];
}
