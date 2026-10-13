/** One role card from the careers list. */
export interface XlightJobRow {
  title: string;
  /** Labels with the `|` separators removed, e.g. ['Engineering', 'Full Time', 'Hybrid', 'Palo Alto']. */
  labels: string[];
  applyHref: string;
}
