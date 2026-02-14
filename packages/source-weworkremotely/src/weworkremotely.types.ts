/**
 * Shape of a parsed RSS item from We Work Remotely.
 */
export interface WwrRssItem {
  title: string | null;
  link: string | null;
  guid: string | null;
  description: string | null;
  pubDate: string | null;
  region: string | null;
  country: string | null;
  state: string | null;
  skills: string | null;
  category: string | null;
  type: string | null;
}
