import { Command, CommandRunner, Option } from 'nest-commander';
import * as fs from 'fs';
import { JobsService } from '../../../api/src/jobs/jobs.service';
import {
  ScraperInputDto, JobPostDto, Site, Country,
  DescriptionFormat, JobType,
} from '@ever-jobs/models';
import { AnalyticsService } from '@ever-jobs/analytics';
import {
  CALLER_OVERRIDES_FLAG_DESCRIPTION,
  CRAWL_FLAG_DESCRIPTION,
  CRAWL_PRESET_FLAG_DESCRIPTION,
  CrawlCliOptions,
  applyCrawlCliOptions,
  parseNonNegativeInt,
} from './crawl-options';

interface SearchOptions extends CrawlCliOptions {
  site?: string[];
  searchTerm?: string;
  googleSearchTerm?: string;
  location?: string;
  distance?: number;
  remote?: boolean;
  jobType?: string;
  easyApply?: boolean;
  results?: number;
  offset?: number;
  hoursOld?: number;
  country?: string;
  descriptionFormat?: string;
  linkedinFetchDescription?: boolean;
  linkedinCompanyIds?: number[];
  enforceAnnualSalary?: boolean;
  timeout?: number;
  proxy?: string[];
  caCert?: string;
  userAgent?: string;
  rateDelayMin?: number;
  rateDelayMax?: number;
  format?: string;
  output?: string;
  verbose?: boolean;
  stdin?: boolean;
  analyze?: boolean;
  bd?: boolean;
  companySlug?: string;
  upworkAuthJson?: string;
}

@Command({
  name: 'search',
  description: 'Search for job postings from one or more job boards. Supports CLI flags or JSON via stdin (--stdin).',
})
export class SearchCommand extends CommandRunner {
  constructor(
    private readonly jobsService: JobsService,
    private readonly analyticsService: AnalyticsService,
  ) {
    super();
  }

  async run(passedParams: string[], options: SearchOptions): Promise<void> {
    // If --stdin flag is set, read JSON from stdin and merge with CLI options
    if (options.stdin) {
      const stdinInput = await this.readStdin();
      return this.runWithJson(stdinInput, options);
    }

    if (options.verbose) {
      console.error('Options:', JSON.stringify(options, null, 2));
    }

    // Build ScraperInputDto from CLI options
    const input = this.buildInputFromOptions(options);
    await this.executeAndOutput(input, options);
  }

  /**
   * Read JSON from stdin for LLM/programmatic usage.
   * Accepts a JSON object with ScraperInputDto fields.
   */
  private async readStdin(): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON input on stdin'));
        }
      });
      process.stdin.on('error', reject);

      // If stdin is a TTY (not piped), prompt and timeout
      if (process.stdin.isTTY) {
        console.error('Reading JSON from stdin (paste JSON and press Ctrl+D)...');
      }
    });
  }

  /**
   * Run with JSON input from stdin, optionally overridden by CLI flags.
   */
  private async runWithJson(jsonInput: Record<string, any>, options: SearchOptions): Promise<void> {
    if (options.verbose) {
      console.error('JSON stdin input:', JSON.stringify(jsonInput, null, 2));
    }

    // Crawl flags (Spec 1690) merge into the JSON's `crawl`, flags winning.
    const input = applyCrawlCliOptions(
      new ScraperInputDto(jsonInput as Partial<ScraperInputDto>),
      options,
    );

    // CLI flags override JSON values
    if (options.format) { /* handled in output */ }
    if (options.output) { /* handled in output */ }

    await this.executeAndOutput(input, options);
  }

  private buildInputFromOptions(options: SearchOptions): ScraperInputDto {
    // Build per-source auth from CLI flags
    let auth: any;
    if (options.upworkAuthJson) {
      try {
        const upworkAuth = JSON.parse(options.upworkAuthJson);
        auth = { upwork: upworkAuth };
      } catch {
        console.error('Warning: Invalid JSON for --upwork-auth-json, ignoring');
      }
    }

    const input = new ScraperInputDto({
      siteType: options.site?.map((s: string) => s as Site),
      searchTerm: options.searchTerm,
      googleSearchTerm: options.googleSearchTerm,
      location: options.location,
      distance: options.distance,
      isRemote: options.remote ?? false,
      jobType: options.jobType as JobType | undefined,
      easyApply: options.easyApply,
      resultsWanted: options.results ?? 15,
      offset: options.offset ?? 0,
      hoursOld: options.hoursOld,
      country: options.country as Country | undefined,
      descriptionFormat: (options.descriptionFormat as DescriptionFormat) ?? DescriptionFormat.MARKDOWN,
      linkedinFetchDescription: options.linkedinFetchDescription ?? false,
      linkedinCompanyIds: options.linkedinCompanyIds,
      enforceAnnualSalary: options.enforceAnnualSalary ?? false,
      requestTimeout: options.timeout ?? 60,
      proxies: options.proxy,
      caCert: options.caCert,
      userAgent: options.userAgent,
      rateDelayMin: options.rateDelayMin,
      rateDelayMax: options.rateDelayMax,
      companySlug: options.companySlug,
      auth,
    });
    return applyCrawlCliOptions(input, options);
  }

  private async executeAndOutput(input: ScraperInputDto, options: SearchOptions): Promise<void> {
    const sitesLabel = input.siteType?.join(', ') ?? 'all';
    console.error(`Searching ${sitesLabel} for "${input.searchTerm ?? ''}"...`);

    const startTime = Date.now();
    const jobs = await this.jobsService.searchJobs(input);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.error(`Found ${jobs.length} jobs in ${elapsed}s`);

    // BD intelligence mode — output company analysis instead of raw jobs
    if (options.bd) {
      const companies = this.analyticsService.analyzeCompanies(jobs);
      const content = JSON.stringify(companies, null, 2);
      this.writeOutput(content, options);
      return;
    }

    // Format job output
    const format = options.format ?? 'json';
    const content = this.formatOutput(jobs, format);
    this.writeOutput(content, options);

    // Append analysis if --analyze flag is set
    if (options.analyze && jobs.length > 0) {
      const analysis = this.analyticsService.analyze(jobs);
      console.error('');
      console.error('=== Analysis ===');
      console.error(`Total: ${analysis.summary.totalJobs} jobs`);
      console.error(`Remote: ${analysis.summary.remoteCount} (${analysis.summary.remotePercentage}%)`);
      console.error(`With salary: ${analysis.summary.withSalaryCount}`);
      if (analysis.summary.salaryStats) {
        const s = analysis.summary.salaryStats;
        console.error(`Salary range: $${s.minSalary.toLocaleString()} - $${s.maxSalary.toLocaleString()} (avg $${s.avgSalary.toLocaleString()})`);
      }
      console.error('');
      console.error('--- By Site ---');
      for (const [site, count] of Object.entries(analysis.summary.bySite)) {
        console.error(`  ${site}: ${count}`);
      }
      if (Object.keys(analysis.summary.byJobType).length > 0) {
        console.error('');
        console.error('--- By Job Type ---');
        for (const [type, count] of Object.entries(analysis.summary.byJobType)) {
          console.error(`  ${type}: ${count}`);
        }
      }
      console.error('');
      console.error('--- Top Companies ---');
      for (const co of analysis.companies.slice(0, 10)) {
        console.error(`  ${co.companyName}: ${co.openPositions} positions`);
      }
    }
  }

  private writeOutput(content: string, options: SearchOptions): void {
    if (options.output) {
      fs.writeFileSync(options.output, content, 'utf-8');
      console.error(`Results saved to ${options.output}`);
    } else {
      process.stdout.write(content + '\n');
    }
  }

  private formatOutput(jobs: JobPostDto[], format: string): string {
    switch (format) {
      case 'json':
        return JSON.stringify(jobs, null, 2);
      case 'csv':
        return this.toCsv(jobs);
      case 'table':
        return this.toTable(jobs);
      case 'summary':
        return this.toSummary(jobs);
      default:
        return JSON.stringify(jobs, null, 2);
    }
  }

  private toCsv(jobs: JobPostDto[]): string {
    if (jobs.length === 0) return '';

    const headers = [
      'id', 'site', 'title', 'companyName', 'location', 'jobUrl',
      'datePosted', 'jobType', 'isRemote', 'minAmount', 'maxAmount',
      'currency', 'interval', 'description',
    ];

    const escape = (val: any): string => {
      if (val == null) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const rows = jobs.map((job) =>
      headers.map((h) => {
        if (h === 'location') {
          const loc = job.location;
          return escape(loc ? [loc.city, loc.state, loc.country].filter(Boolean).join(', ') : '');
        }
        if (h === 'minAmount') return escape(job.compensation?.minAmount);
        if (h === 'maxAmount') return escape(job.compensation?.maxAmount);
        if (h === 'currency') return escape(job.compensation?.currency);
        if (h === 'interval') return escape(job.compensation?.interval);
        if (h === 'jobType') return escape(Array.isArray(job.jobType) ? job.jobType.join('; ') : job.jobType);
        return escape((job as any)[h]);
      }).join(','),
    );

    return [headers.join(','), ...rows].join('\n');
  }

  private toTable(jobs: JobPostDto[]): string {
    if (jobs.length === 0) return 'No jobs found.';

    const cols = ['Site', 'Title', 'Company', 'Location', 'Posted', 'Remote'];
    const widths = [12, 40, 25, 25, 12, 7];

    const pad = (str: string, width: number): string =>
      str.length > width ? str.slice(0, width - 1) + '…' : str.padEnd(width);

    const header = cols.map((c, i) => pad(c, widths[i])).join(' │ ');
    const separator = widths.map((w) => '─'.repeat(w)).join('─┼─');

    const rows = jobs.map((job) => {
      const loc = job.location;
      const locStr = loc ? [loc.city, loc.state].filter(Boolean).join(', ') : '';
      const dateStr = job.datePosted ? String(job.datePosted).slice(0, 10) : '';
      const remoteStr = job.isRemote ? 'Yes' : 'No';

      return [
        pad(job.site ?? '', widths[0]),
        pad(job.title ?? '', widths[1]),
        pad(job.companyName ?? '', widths[2]),
        pad(locStr, widths[3]),
        pad(dateStr, widths[4]),
        pad(remoteStr, widths[5]),
      ].join(' │ ');
    });

    return [header, separator, ...rows].join('\n');
  }

  private toSummary(jobs: JobPostDto[]): string {
    if (jobs.length === 0) return 'No jobs found.';

    const bySite = new Map<string, number>();
    const byType = new Map<string, number>();
    let remoteCount = 0;
    let salaryCount = 0;

    for (const job of jobs) {
      const site = job.site ?? 'unknown';
      bySite.set(site, (bySite.get(site) ?? 0) + 1);

      if (job.jobType) {
        for (const jt of job.jobType) {
          byType.set(jt, (byType.get(jt) ?? 0) + 1);
        }
      }
      if (job.isRemote) remoteCount++;
      if (job.compensation?.minAmount) salaryCount++;
    }

    const lines: string[] = [
      `=== Job Search Summary ===`,
      `Total jobs found: ${jobs.length}`,
      `Remote positions: ${remoteCount}`,
      `With salary data: ${salaryCount}`,
      '',
      `--- By Source ---`,
    ];
    for (const [site, count] of bySite.entries()) {
      lines.push(`  ${site}: ${count}`);
    }

    if (byType.size > 0) {
      lines.push('', '--- By Job Type ---');
      for (const [type, count] of byType.entries()) {
        lines.push(`  ${type}: ${count}`);
      }
    }

    return lines.join('\n');
  }

  // ── Option Decorators ──

  @Option({ flags: '--stdin', description: 'Read JSON input from stdin (for LLM/programmatic usage)' })
  parseStdin(): boolean { return true; }

  @Option({ flags: '-s, --site [sites...]', description: 'Sites to search: linkedin, indeed, glassdoor, zip_recruiter, google, bayt, naukri, bdjobs, internshala, exa, upwork, ashby, greenhouse, lever, workable, smartrecruiters, rippling, workday' })
  parseSite(val: string, acc?: string[]): string[] {
    return (acc ?? []).concat(val);
  }

  @Option({ flags: '-q, --search-term <term>', description: 'Job search keywords' })
  parseSearchTerm(val: string): string { return val; }

  @Option({ flags: '--google-search-term <term>', description: 'Google-specific search query override' })
  parseGoogleSearchTerm(val: string): string { return val; }

  @Option({ flags: '-l, --location <location>', description: 'Location to search near' })
  parseLocation(val: string): string { return val; }

  @Option({ flags: '-d, --distance <miles>', description: 'Search radius in miles (default: 50)' })
  parseDistance(val: string): number { return parseInt(val, 10); }

  @Option({ flags: '-r, --remote', description: 'Filter for remote jobs only' })
  parseRemote(): boolean { return true; }

  @Option({ flags: '--job-type <type>', description: 'Filter by job type: fulltime, parttime, internship, contract' })
  parseJobType(val: string): string { return val; }

  @Option({ flags: '--easy-apply', description: 'Filter for easy-apply / hosted jobs' })
  parseEasyApply(): boolean { return true; }

  @Option({ flags: '-n, --results <count>', description: 'Number of results wanted per site (default: 15)' })
  parseResults(val: string): number { return parseInt(val, 10); }

  @Option({ flags: '--offset <n>', description: 'Skip first N results' })
  parseOffset(val: string): number { return parseInt(val, 10); }

  @Option({ flags: '--hours-old <hours>', description: 'Max job age in hours' })
  parseHoursOld(val: string): number { return parseInt(val, 10); }

  @Option({ flags: '-c, --country <code>', description: 'Country for Indeed/Glassdoor domain (default: USA)' })
  parseCountry(val: string): string { return val; }

  @Option({ flags: '--description-format <fmt>', description: 'Description format: markdown, html, plain (default: markdown)' })
  parseDescriptionFormat(val: string): string { return val; }

  @Option({ flags: '--linkedin-fetch-description', description: 'Fetch full LinkedIn descriptions (slower)' })
  parseLinkedinFetchDescription(): boolean { return true; }

  @Option({ flags: '--linkedin-company-ids [ids...]', description: 'Filter LinkedIn by company IDs' })
  parseLinkedinCompanyIds(val: string, acc?: number[]): number[] {
    return (acc ?? []).concat(parseInt(val, 10));
  }

  @Option({ flags: '--enforce-annual-salary', description: 'Convert all wages to annual equivalent' })
  parseEnforceAnnualSalary(): boolean { return true; }

  @Option({ flags: '--timeout <seconds>', description: 'Request timeout in seconds (default: 60)' })
  parseTimeout(val: string): number { return parseInt(val, 10); }

  @Option({ flags: '-p, --proxy [urls...]', description: 'Proxy URLs for rotation' })
  parseProxy(val: string, acc?: string[]): string[] {
    return (acc ?? []).concat(val);
  }

  @Option({ flags: '--ca-cert <path>', description: 'Path to CA certificate for proxies' })
  parseCaCert(val: string): string { return val; }

  @Option({ flags: '--user-agent <ua>', description: 'Custom User-Agent string' })
  parseUserAgent(val: string): string { return val; }

  @Option({ flags: '--rate-delay-min <seconds>', description: 'Minimum delay between requests in seconds' })
  parseRateDelayMin(val: string): number { return parseFloat(val); }

  @Option({ flags: '--rate-delay-max <seconds>', description: 'Maximum delay between requests in seconds' })
  parseRateDelayMax(val: string): number { return parseFloat(val); }

  @Option({ flags: '-f, --format <format>', description: 'Output format: json, csv, table, summary (default: json)' })
  parseFormat(val: string): string { return val; }

  @Option({ flags: '-o, --output <file>', description: 'Write output to file instead of stdout' })
  parseOutput(val: string): string { return val; }

  @Option({ flags: '-v, --verbose', description: 'Enable verbose debug output' })
  parseVerbose(): boolean { return true; }

  @Option({ flags: '--no-description', description: 'Omit job descriptions from output (reduces size for LLMs)' })
  parseNoDescription(): boolean { return true; }

  @Option({ flags: '--analyze', description: 'Append summary analysis (salary, remote %, top companies) after results' })
  parseAnalyze(): boolean { return true; }

  @Option({ flags: '--bd', description: 'BD intelligence mode: output company analysis instead of raw jobs' })
  parseBd(): boolean { return true; }

  @Option({ flags: '--company-slug <slug>', description: 'Company slug for ATS board scraping (e.g., "stripe" for Ashby, "github" for Greenhouse, "tesla:5:Tesla" for Workday)' })
  parseCompanySlug(val: string): string { return val; }

  @Option({ flags: '--upwork-auth-json <json>', description: 'Upwork auth credentials as JSON: \'{"clientId":"...","clientSecret":"...","grantType":"client_credentials"}\'' })
  parseUpworkAuthJson(val: string): string { return val; }

  // ── Crawl policy (Spec 1690) ──

  @Option({ flags: '--crawl <json>', description: CRAWL_FLAG_DESCRIPTION })
  parseCrawl(val: string): string { return val; }

  @Option({ flags: '--user-agent-mode <mode>', description: 'Which User-Agent goes out: identify (default), strict, plugin' })
  parseUserAgentMode(val: string): string { return val; }

  @Option({ flags: '--proxy-rotation <mode>', description: 'Proxy rotation: per-host (default), per-scrape, per-request (pre-1690), off' })
  parseProxyRotation(val: string): string { return val; }

  @Option({ flags: '--max-per-host <n>', description: 'Max requests in flight per host bucket (0 = unlimited)' })
  parseMaxPerHost(val: string): number { return parseNonNegativeInt(val); }

  @Option({ flags: '--min-interval-ms <ms>', description: 'Minimum gap between request starts per host bucket, ms' })
  parseMinIntervalMs(val: string): number { return parseNonNegativeInt(val); }

  @Option({ flags: '--crawl-retries <n>', description: 'Retries per request on 429/5xx (crawl policy)' })
  parseCrawlRetries(val: string): number { return parseNonNegativeInt(val); }

  @Option({ flags: '--robots-txt <mode>', description: 'robots.txt handling: off (default), crawl-delay, respect' })
  parseRobotsTxt(val: string): string { return val; }

  @Option({ flags: '--discovery <mode>', description: 'Discovery for multi-strategy sources (e.g. Softy): auto (default), sitemap, listing' })
  parseDiscovery(val: string): string { return val; }

  @Option({ flags: '--crawl-preset <preset>', description: CRAWL_PRESET_FLAG_DESCRIPTION })
  parseCrawlPreset(val: string): string { return val; }

  @Option({ flags: '--caller-overrides <mode>', description: CALLER_OVERRIDES_FLAG_DESCRIPTION })
  parseCallerOverrides(val: string): string { return val; }
}
