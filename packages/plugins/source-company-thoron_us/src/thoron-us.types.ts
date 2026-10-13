/** One role entry from the bundle's embedded jobs array. */
export interface ThoronJobEntry {
  id: string;
  title: string;
  department: string;
  location: string;
  type: string;
  whatYoullDo: string[];
  whatYouBring: string[];
  niceToHaves: string[];
}
