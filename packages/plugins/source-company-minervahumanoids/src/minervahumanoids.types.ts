/** `window.__minervaContent` job-entry shape (hand-rolled static CMS). */
export interface MinervaHumanoidsBlock {
  kind?: string;
  text?: string;
  items?: string[];
}

export interface MinervaHumanoidsJob {
  id?: string;
  title?: string;
  location?: string;
  published?: boolean;
  applyUrl?: string;
  program?: string;
  blocks?: MinervaHumanoidsBlock[];
}

export interface MinervaHumanoidsContent {
  jobs?: MinervaHumanoidsJob[];
}

export interface MinervaHumanoidsPayload {
  content?: MinervaHumanoidsContent;
}
