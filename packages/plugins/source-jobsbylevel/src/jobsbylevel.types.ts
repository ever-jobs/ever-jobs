import { CompensationDto, JobPostDto } from '@ever-jobs/models';

/** Which robots-allowed read path a scrape uses (Spec 1693). */
export type JobsByLevelTransport = 'mcp' | 'feed';

/**
 * Company as an object. The live MCP payload carries a plain `company` string
 * plus `company_slug`; the object form is accepted defensively.
 */
export interface JobsByLevelCompanyObject {
  name?: string | null;
  slug?: string | null;
  website?: string | null;
}

/**
 * One listing from `search_jobs` (and, with the detail-only fields, from
 * `get_job`). Shape verified live on 2026-09-25; every field is optional
 * because the mapper must survive drift.
 */
export interface JobsByLevelItem {
  id?: string | null;
  slug?: string | null;
  title?: string | null;
  company?: string | JobsByLevelCompanyObject | null;
  company_slug?: string | null;
  location?: string | null;
  remote?: boolean | number | string | null;
  /** ISO 3166-1 alpha-2; `UK` is normalised to `GB`. */
  country?: string | null;
  /** Free text, e.g. `Full-time`, `FullTime`, `full_time`. */
  employment_type?: string | null;
  salary_min?: number | string | null;
  salary_max?: number | string | null;
  salary_currency?: string | null;
  /** Not in the live payload; honoured if the operator adds it. */
  salary_frequency?: string | null;
  category?: string | null;
  seniority?: string | null;
  /** 1 to 4. */
  ai_level?: number | string | null;
  /** 0 to 100. */
  ai_score?: number | string | null;
  tools?: unknown;
  posted_at?: string | null;
  /** Canonical `https://jobsbylevel.com/jobs/<slug>` page (with the operator's `utm_source`). */
  url?: string | null;
  source?: string | null;
  sponsored?: boolean | null;
  // Detail-only fields (`get_job`).
  skills?: unknown;
  /** Full description, plain text. */
  description_text?: string | null;
  expires_at?: string | null;
  company_website?: string | null;
}

/** `search_jobs` payload. */
export interface JobsByLevelSearchEnvelope {
  total?: number | null;
  page?: number | null;
  per_page?: number | null;
  items: JobsByLevelItem[];
}

/** Arguments of the `search_jobs` MCP tool (operator server card). */
export interface JobsByLevelSearchArgs {
  query?: string;
  ai_level_min?: number;
  ai_level_max?: number;
  remote?: boolean;
  city?: string;
  company?: string;
  page: number;
}

/** A JSON-RPC 2.0 response as the MCP endpoint returns it. */
export interface JobsByLevelRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

/** One `<item>` of `/feed.xml`. */
export interface JobsByLevelFeedItem {
  slug: string;
  url: string;
  title: string;
  companyName: string | null;
  /** ISO-8601 UTC instant from `<pubDate>`, or null when unparseable. */
  postedAt: string | null;
  /** Plain-text snippet, hard-cut by the operator at ~300 characters. */
  snippet: string | null;
}

/** What one detail read adds to a listing (either transport). */
export interface JobsByLevelDetail {
  description: string | null;
  /** `true` when {@link description} is HTML (JSON-LD), `false` for plain text (MCP). */
  descriptionIsHtml: boolean;
  skills: string[];
  companyWebsite: string | null;
  countryCode: string | null;
  remote: boolean | null;
  aiLevel: number | null;
  compensation: CompensationDto | null;
  employmentType: string | null;
  atsId: string | null;
}

/**
 * The job this plugin emits: a standard {@link JobPostDto} plus the additive
 * 1-4 AI-centrality rating (not seniority). `aiLevel` is declared on
 * `JobPostDto`; REST JSON carries it, GraphQL does not select it yet.
 */
export type JobsByLevelJobPost = JobPostDto & { aiLevel?: number | null };
