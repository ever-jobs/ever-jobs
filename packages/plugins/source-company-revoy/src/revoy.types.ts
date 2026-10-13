export interface RevoyJobRef {
  docId: string;
  docUrl: string;
  title: string;
  /** ` — City, ST` trailing the role link on the index row. */
  linkLocation: string | null;
}
