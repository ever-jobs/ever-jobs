/**
 * ReliefWeb API v2 `/v2/jobs` response (Spec 1752). v2 is documented as fully
 * compatible with v1: `data[]` entries carry `id`, `score`, `href` (the entry's
 * API resource — never a link) and the requested `fields`.
 */
export interface ReliefWebResponse {
  href: string;
  count: number;
  totalCount: number;
  data: ReliefWebJobEntry[];
}

export interface ReliefWebJobEntry {
  id: string;
  score: number;
  /** API resource, `https://api.reliefweb.int/v2/jobs/<id>`. Never a link. */
  href: string;
  fields: ReliefWebJobFields;
}

export interface ReliefWebJobFields {
  title: string;
  /** Job description in Markdown. */
  body?: string;
  /** Job description in HTML. */
  'body-html'?: string;
  /** Canonical URL of the job page on reliefweb.int. */
  url?: string;
  /** "Friendly" URL of the job page: `https://reliefweb.int/job/<id>/<slug>`. */
  url_alias?: string;
  source?: { name: string; shortname?: string; href?: string }[];
  date?: { created: string; closing?: string; changed?: string };
  country?: { name: string; iso3?: string }[];
  theme?: { name: string }[];
  type?: { name: string }[];
}

/** The body of a ReliefWeb API error (e.g. the 403 for an unapproved appname). */
export interface ReliefWebErrorBody {
  status?: number;
  error?: { type?: string; message?: string };
}
