import {
  IsOptional, IsString, IsBoolean, IsNumber, IsArray, IsEnum, ValidateNested, ArrayMaxSize, MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Site } from '../enums/site.enum';
import { JobType } from '../enums/job-type.enum';
import { DescriptionFormat } from '../enums/description-format.enum';
import { Country } from '../enums/country.enum';
import { ExclusionPreset } from '../enums/exclusion-preset.enum';
import { ScraperAuthDto } from './auth/scraper-auth.dto';
import { CrawlPolicyDto } from './crawl-policy.dto';

/**
 * Hard ceiling on `locations` entries a request may carry (Spec 1700). The
 * server searches at most the operator cap (`EVER_JOBS_SEARCH_MAX_LOCATIONS`,
 * default {@link DEFAULT_MAX_SEARCH_LOCATIONS}) and reports the rest as
 * `bad_input` diagnostics; anything above this ceiling is a 400.
 */
export const HARD_MAX_SEARCH_LOCATIONS = 25;

/** Default number of `locations` entries actually searched (Spec 1700). */
export const DEFAULT_MAX_SEARCH_LOCATIONS = 10;

/** Longest accepted single `locations` entry, in characters (Spec 1700). */
export const MAX_SEARCH_LOCATION_LENGTH = 200;

/** Most terms accepted per exclusion list (Spec 1700). */
export const MAX_EXCLUSION_TERMS = 50;

/** Longest accepted exclusion term, in characters (Spec 1700). */
export const MAX_EXCLUSION_TERM_LENGTH = 100;

export class ScraperInputDto {
  @ApiPropertyOptional({ enum: Site, isArray: true, description: 'Sites to scrape (default: search + company scrapers; omit or pass explicit values to override)' })
  @IsOptional()
  @IsArray()
  @IsEnum(Site, { each: true })
  siteType?: Site[];

  @ApiPropertyOptional({
    description: 'Company domains to resolve to registered Site tokens. Each domain is mapped via the Spec 5069 rule (e.g. boomsupersonic.com → boomsupersonic, hyl.io → hyl_io). Resolved tokens are unioned with siteType. Domains that do not map to a registered Site token produce a 400 only when no valid siteType or resolvable domain remains; otherwise they are returned as per-source diagnostics.',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  companyDomain?: string[];

  @ApiPropertyOptional({ description: 'Search term / keywords' })
  @IsOptional()
  @IsString()
  searchTerm?: string;

  @ApiPropertyOptional({ description: 'Google-specific search term override' })
  @IsOptional()
  @IsString()
  googleSearchTerm?: string;

  @ApiPropertyOptional({ description: 'Location to search near' })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({
    description:
      'Several locations to search in one request (Spec 1700). The query runs once per location for every selected ' +
      'source, one location after another per source (each call has its own offset and resultsWanted); results are ' +
      'merged and exact same-source duplicates removed. `location`, when also set, is searched first. Entries are ' +
      'trimmed, blanks dropped and case-insensitive duplicates collapsed. At most ' +
      `${HARD_MAX_SEARCH_LOCATIONS} entries are accepted; the server searches the first ` +
      `\`EVER_JOBS_SEARCH_MAX_LOCATIONS\` (default ${DEFAULT_MAX_SEARCH_LOCATIONS}) and reports the rest as ` +
      '`bad_input` diagnostics. Per-source diagnostics then carry one row per (source, location) with a `location` field.',
    type: String,
    isArray: true,
    maxItems: HARD_MAX_SEARCH_LOCATIONS,
    example: ['New York, NY', 'Chicago, IL'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(HARD_MAX_SEARCH_LOCATIONS)
  @IsString({ each: true })
  @MaxLength(MAX_SEARCH_LOCATION_LENGTH, { each: true })
  locations?: string[];

  @ApiPropertyOptional({ description: 'Distance in miles from location', default: 50 })
  @IsOptional()
  @IsNumber()
  distance?: number;

  @ApiPropertyOptional({ description: 'Only remote jobs', default: false })
  @IsOptional()
  @IsBoolean()
  isRemote?: boolean;

  @ApiPropertyOptional({ enum: JobType, description: 'Filter by job type' })
  @IsOptional()
  @IsEnum(JobType)
  jobType?: JobType;

  @ApiPropertyOptional({ description: 'Only easy-apply jobs' })
  @IsOptional()
  @IsBoolean()
  easyApply?: boolean;

  @ApiPropertyOptional({
    description: 'Number of results wanted, per source (and per location when `locations` is set)',
    default: 15,
  })
  @IsOptional()
  @IsNumber()
  resultsWanted?: number;

  @ApiPropertyOptional({
    description: 'Offset for pagination, per source (and per location when `locations` is set)',
    default: 0,
  })
  @IsOptional()
  @IsNumber()
  offset?: number;

  @ApiPropertyOptional({ description: 'Max age of listings in hours' })
  @IsOptional()
  @IsNumber()
  hoursOld?: number;

  @ApiPropertyOptional({ enum: Country, description: 'Country for Indeed/Glassdoor domain resolution' })
  @IsOptional()
  @IsEnum(Country)
  country?: Country;

  @ApiPropertyOptional({ enum: DescriptionFormat, description: 'Description output format', default: DescriptionFormat.MARKDOWN })
  @IsOptional()
  @IsEnum(DescriptionFormat)
  descriptionFormat?: DescriptionFormat;

  @ApiPropertyOptional({ description: 'Fetch full LinkedIn descriptions', default: false })
  @IsOptional()
  @IsBoolean()
  linkedinFetchDescription?: boolean;

  @ApiPropertyOptional({
    description:
      'Fetch each LinkedIn company page once (sequential, cached, capped at 25) to fill website, size, HQ, industry, description and logo. ' +
      'Unset = EVER_JOBS_LINKEDIN_FETCH_COMPANY_DETAILS (off by default) (Spec 1701)',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  linkedinFetchCompanyDetails?: boolean;

  @ApiPropertyOptional({ description: 'LinkedIn company IDs to filter by', isArray: true })
  @IsOptional()
  @IsArray()
  linkedinCompanyIds?: number[];

  @ApiPropertyOptional({ description: 'Request timeout in seconds', default: 60 })
  @IsOptional()
  @IsNumber()
  requestTimeout?: number;

  @ApiPropertyOptional({
    description:
      'Proxy URLs. Used by every source of the search (crawl.proxyRotation picks among them) unless the operator ' +
      'set EVER_JOBS_CRAWL_CALLER_PROXIES=none; each is egress-checked (no private / internal proxy hosts) (Spec 1690).',
    isArray: true,
    type: String,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  proxies?: string[];

  @ApiPropertyOptional({ description: 'Custom CA certificate path' })
  @IsOptional()
  @IsString()
  caCert?: string;

  @ApiPropertyOptional({ description: 'Custom user agent string. Maps to crawl.userAgent and, unless crawl.userAgentMode is also set, crawl.userAgentMode=strict so this UA is what goes on the wire (Spec 1690).' })
  @IsOptional()
  @IsString()
  userAgent?: string;

  @ApiPropertyOptional({ description: 'Client IP address for sources that require it (e.g. CareerJet). Also useful for proxy rotation.' })
  @IsOptional()
  @IsString()
  clientIp?: string;

  @ApiPropertyOptional({ description: 'Convert all wages to annual salary equivalent', default: false })
  @IsOptional()
  @IsBoolean()
  enforceAnnualSalary?: boolean;

  @ApiPropertyOptional({ description: 'Minimum delay between requests in seconds (rate limiting). Maps to crawl.minIntervalMs = rateDelayMin × 1000, enforced per rate-limit bucket across concurrent requests (Spec 1690).' })
  @IsOptional()
  @IsNumber()
  rateDelayMin?: number;

  @ApiPropertyOptional({ description: 'Maximum delay between requests in seconds (rate limiting). Maps to crawl.jitterMs = (rateDelayMax − rateDelayMin) × 1000 (Spec 1690).' })
  @IsOptional()
  @IsNumber()
  rateDelayMax?: number;

  @ApiPropertyOptional({ description: 'Company slug for ATS board scraping (e.g., "stripe" for Ashby, "github" for Greenhouse)' })
  @IsOptional()
  @IsString()
  companySlug?: string;

  @ApiPropertyOptional({
    description:
      'Custom-domain career portal URL (e.g., "https://careers.ibm.com" or "https://bloomberg.avature.net"). When set, ATS scrapers prefer this over `companySlug`-derived subdomain construction. If `companyDomain` does not map to a registered `Site` token, a canonical ATS board URL (e.g., "https://boards.greenhouse.io/<slug>" or "https://jobs.ashbyhq.com/<slug>") is also used as a fallback selector and to populate `companySlug`. Used by the Avature plugin (Spec 006 / Q-022).',
  })
  @IsOptional()
  @IsString()
  companyUrl?: string;

  @ApiPropertyOptional({ description: 'Maximum concurrent company scrapes for ATS sources', default: 5 })
  @IsOptional()
  @IsNumber()
  maxConcurrentCompanies?: number;

  @ApiPropertyOptional({
    description:
      'Oracle HCM Cloud `siteNumber` finder parameter. Defaults to "CX_45001" inside the Oracle plugin (Spec 013 / Q-030 / FR-4) when unset; override only for the residual ~5 % of tenants using a non-default site number.',
  })
  @IsOptional()
  @IsString()
  siteNumber?: string;

  @ApiPropertyOptional({
    enum: ['board', 'detail-25', 'detail-all'],
    description:
      'Tesla per-job description fetch budget (Spec 013 / Q-031 / FR-11). `board` skips per-job GETs (descriptions remain empty); `detail-25` (default) caps follow-ups at 25 to honour NFR-2; `detail-all` fetches every job (multi-hour cost — opt-in only). Also honoured by Softy (Spec 1691), where unset means every wanted offer and `board` also selects listing discovery under `crawl.discovery=auto`.',
    default: 'detail-25',
  })
  @IsOptional()
  @IsString()
  descriptionDepth?: 'board' | 'detail-25' | 'detail-all';

  @ApiPropertyOptional({ description: 'Number of retries for failed requests. Maps to crawl.retries when sent (Spec 1690).', default: 3 })
  @IsOptional()
  @IsNumber()
  retries?: number;

  @ApiPropertyOptional({ description: 'Delay between retries in milliseconds. Maps to crawl.retryBaseDelayMs when sent (Spec 1690).', default: 1000 })
  @IsOptional()
  @IsNumber()
  retryDelay?: number;

  @ApiPropertyOptional({ enum: ['linear', 'exponential'], description: 'Backoff strategy for retries. Maps to crawl.retryBackoff when sent (Spec 1690).', default: 'linear' })
  @IsOptional()
  @IsString()
  retryBackoff?: 'linear' | 'exponential';

  @ApiPropertyOptional({ description: 'Maximum delay between retries in milliseconds. Maps to crawl.retryMaxDelayMs when sent (Spec 1690).', default: 30000 })
  @IsOptional()
  @IsNumber()
  retryMaxDelay?: number;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_EXCLUSION_TERMS,
    example: ['senior', 'lead*', 'principal'],
    description:
      'Drop jobs whose TITLE contains any of these words or phrases (Spec 1700). Case- and accent-insensitive, ' +
      'whole-word; multi-word terms match as a phrase; a trailing * is a prefix wildcard (at least 3 characters). ' +
      'Literal text, never a regex. Negated mentions ("no clearance required") are ignored. Applied after the ' +
      'fan-out and dedup: the cache and the persisted corpus are unaffected, and a source can return fewer than ' +
      'resultsWanted.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EXCLUSION_TERMS)
  @IsString({ each: true })
  @MaxLength(MAX_EXCLUSION_TERM_LENGTH, { each: true })
  excludeTitleTerms?: string[];

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_EXCLUSION_TERMS,
    example: ['security clearance', 'ts/sci', 'polygraph'],
    description:
      'Drop jobs whose TITLE or DESCRIPTION contains any of these words or phrases (Spec 1700). Same matching ' +
      'rules as excludeTitleTerms: case- and accent-insensitive, whole-word, phrases, trailing * prefix, literal ' +
      'text (never a regex), negated mentions ignored, HTML tags and entities in descriptions are not matched.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EXCLUSION_TERMS)
  @IsString({ each: true })
  @MaxLength(MAX_EXCLUSION_TERM_LENGTH, { each: true })
  excludeKeywords?: string[];

  @ApiPropertyOptional({
    enum: ExclusionPreset,
    isArray: true,
    description:
      'Curated exclusion lists matched against title + description (Spec 1700). `security_clearance` drops roles ' +
      'that require a security clearance or vetting, including "clearance eligible" / "able to obtain a clearance" ' +
      'roles (US, UK, Canadian and Australian vocabulary). Negated mentions ("no clearance required") are kept.',
  })
  @IsOptional()
  @IsArray()
  @IsEnum(ExclusionPreset, { each: true })
  excludePresets?: ExclusionPreset[];

  @ApiPropertyOptional({
    type: () => ScraperAuthDto,
    description: 'Per-request authentication credentials for individual sources (overrides env vars)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ScraperAuthDto)
  auth?: ScraperAuthDto;

  @ApiPropertyOptional({
    type: () => CrawlPolicyDto,
    description:
      'Per-request crawl policy (Spec 1690): identity, pacing, proxy rotation, retries, robots.txt and discovery. Highest-precedence layer, subject to the operator setting EVER_JOBS_CRAWL_CALLER_OVERRIDES (any | stricter | none). Where a field is also set through a legacy flat field (userAgent, rateDelayMin/Max, retries, retryDelay, retryBackoff, retryMaxDelay), the value here wins. The preset (EVER_JOBS_CRAWL_PRESET) is process-wide and cannot be chosen per request.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CrawlPolicyDto)
  crawl?: CrawlPolicyDto;

  constructor(partial?: Partial<ScraperInputDto>) {
    this.resultsWanted = 15;
    this.offset = 0;
    this.distance = 50;
    this.isRemote = false;
    this.country = Country.USA;
    this.descriptionFormat = DescriptionFormat.MARKDOWN;
    this.linkedinFetchDescription = false;
    this.requestTimeout = 60;
    this.maxConcurrentCompanies = 5;
    Object.assign(this, partial);
  }
}
