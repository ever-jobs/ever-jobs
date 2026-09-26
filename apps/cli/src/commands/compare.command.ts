import { Command, CommandRunner, Option } from 'nest-commander';
import * as fs from 'fs';
import { JobsService } from '../../../api/src/jobs/jobs.service';
import {
  ScraperInputDto, Site, Country,
  DescriptionFormat, JobType, SiteComparisonDto, ExclusionPreset,
} from '@ever-jobs/models';
import {
  applyJobExclusions, compileJobExclusions, exclusionSpecFromInput, hasExclusionInput,
} from '@ever-jobs/common';
import { AnalyticsService } from '@ever-jobs/analytics';
import {
  CALLER_OVERRIDES_FLAG_DESCRIPTION,
  CRAWL_FLAG_DESCRIPTION,
  CRAWL_PRESET_FLAG_DESCRIPTION,
  CrawlCliOptions,
  applyCrawlCliOptions,
  parseNonNegativeInt,
} from './crawl-options';

interface CompareOptions extends CrawlCliOptions {
  searchTerm?: string;
  location?: string;
  /** Spec 1700 — several locations, each searched per site. */
  locations?: string[];
  excludeTitle?: string[];
  excludeKeyword?: string[];
  excludePreset?: string[];
  results?: number;
  country?: string;
  descriptionFormat?: string;
  hoursOld?: number;
  remote?: boolean;
  jobType?: string;
  rateDelayMin?: number;
  rateDelayMax?: number;
  format?: string;
  output?: string;
  verbose?: boolean;
}

@Command({
  name: 'compare',
  description: 'Search across all job boards individually and compare results side-by-side.',
})
export class CompareCommand extends CommandRunner {
  constructor(
    private readonly jobsService: JobsService,
    private readonly analyticsService: AnalyticsService,
  ) {
    super();
  }

  async run(_passedParams: string[], options: CompareOptions): Promise<void> {
    const searchTerm = options.searchTerm ?? 'software engineer';
    const sites = Object.values(Site);

    console.error(`Comparing "${searchTerm}" across ${sites.length} sites...\n`);

    // Build common input (minus siteType)
    const baseInput = applyCrawlCliOptions(new ScraperInputDto({
      searchTerm,
      location: options.location,
      resultsWanted: options.results ?? 15,
      country: options.country as Country | undefined,
      descriptionFormat: (options.descriptionFormat as DescriptionFormat) ?? DescriptionFormat.MARKDOWN,
      hoursOld: options.hoursOld,
      isRemote: options.remote ?? false,
      jobType: options.jobType as JobType | undefined,
      rateDelayMin: options.rateDelayMin,
      rateDelayMax: options.rateDelayMax,
      // Spec 1700 — set only when given, so a plain compare builds the same input as before.
      ...(options.locations ? { locations: options.locations } : {}),
      ...(options.excludeTitle ? { excludeTitleTerms: options.excludeTitle } : {}),
      ...(options.excludeKeyword ? { excludeKeywords: options.excludeKeyword } : {}),
      ...(options.excludePreset ? { excludePresets: options.excludePreset as ExclusionPreset[] } : {}),
    }), options);
    // Compiled once, applied per site so the printed counts match the comparison.
    const exclusions = hasExclusionInput(baseInput)
      ? compileJobExclusions(exclusionSpecFromInput(baseInput))
      : undefined;
    let excludedTotal = 0;

    // Scrape each site individually (sequentially to avoid rate-limiting)
    const allJobs = [];

    for (const site of sites) {
      process.stderr.write(`  ${site}... `);
      try {
        const input = new ScraperInputDto({
          ...baseInput,
          siteType: [site],
        });
        let jobs = await this.jobsService.searchJobs(input);
        if (exclusions) {
          const filtered = applyJobExclusions(jobs, exclusions);
          excludedTotal += filtered.excluded.length;
          jobs = filtered.kept;
          console.error(`${jobs.length} jobs (${filtered.excluded.length} excluded)`);
        } else {
          console.error(`${jobs.length} jobs`);
        }
        allJobs.push(...jobs);
      } catch (err: any) {
        console.error(`failed (${err.message})`);
      }
    }
    if (exclusions) {
      for (const ignored of exclusions.ignored) {
        console.error(`Ignored exclusion term "${ignored.term}" (${ignored.reason})`);
      }
    }

    // Generate comparison
    const comparison = this.analyticsService.compareSites(allJobs);

    // Output comparison table
    console.error('');
    const header = ['Site', 'Total', 'With Salary', 'Remote', 'Unique Companies'];
    const rows: string[][] = comparison.map((c: SiteComparisonDto) => [
      c.site, String(c.totalJobs), String(c.withSalary),
      String(c.remoteJobs), String(c.uniqueCompanies),
    ]);

    // Calculate column widths
    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r: string[]) => r[i].length)) + 2,
    );

    const printRow = (row: string[]) =>
      row.map((cell, i) => cell.padEnd(widths[i])).join('│ ');

    console.error(printRow(header));
    console.error(widths.map((w) => '─'.repeat(w)).join('┼─'));
    for (const row of rows) {
      console.error(printRow(row));
    }

    console.error(`\nTotal: ${allJobs.length} jobs from ${comparison.length} sites`);

    // Also output JSON to stdout
    const output = {
      searchTerm,
      totalJobs: allJobs.length,
      siteComparison: comparison,
      summary: this.analyticsService.summarize(allJobs),
      // Spec 1700 — present only when exclusions were requested.
      ...(exclusions ? { excludedJobs: excludedTotal } : {}),
    };

    const content = JSON.stringify(output, null, 2);
    if (options.output) {
      fs.writeFileSync(options.output, content, 'utf-8');
      console.error(`Results saved to ${options.output}`);
    } else {
      process.stdout.write(content + '\n');
    }
  }

  // ── Option Decorators ──

  @Option({ flags: '-q, --search-term <term>', description: 'Job search keywords' })
  parseSearchTerm(val: string): string { return val; }

  @Option({ flags: '-l, --location <location>', description: 'Location to search near' })
  parseLocation(val: string): string { return val; }

  @Option({
    flags: '--locations <locations...>',
    description: 'Several locations; each site is searched once per location, one after another',
  })
  parseLocations(val: string, acc?: string[]): string[] {
    return (acc ?? []).concat(val);
  }

  @Option({ flags: '--exclude-title <terms...>', description: 'Drop jobs whose TITLE contains any of these words/phrases' })
  parseExcludeTitle(val: string, acc?: string[]): string[] {
    return (acc ?? []).concat(val);
  }

  @Option({
    flags: '--exclude-keyword <terms...>',
    description: 'Drop jobs whose TITLE or DESCRIPTION contains any of these words/phrases',
  })
  parseExcludeKeyword(val: string, acc?: string[]): string[] {
    return (acc ?? []).concat(val);
  }

  @Option({
    flags: '--exclude-preset <presets...>',
    description: `Curated exclusion lists: ${Object.values(ExclusionPreset).join(', ')}`,
  })
  parseExcludePreset(val: string, acc?: string[]): string[] {
    return (acc ?? []).concat(val);
  }

  @Option({ flags: '-n, --results <count>', description: 'Results per site (default: 15)' })
  parseResults(val: string): number { return parseInt(val, 10); }

  @Option({ flags: '-c, --country <code>', description: 'Country (default: USA)' })
  parseCountry(val: string): string { return val; }

  @Option({ flags: '--hours-old <hours>', description: 'Max job age in hours' })
  parseHoursOld(val: string): number { return parseInt(val, 10); }

  @Option({ flags: '-r, --remote', description: 'Remote jobs only' })
  parseRemote(): boolean { return true; }

  @Option({ flags: '--job-type <type>', description: `Filter by job type: ${Object.values(JobType).join(', ')}` })
  parseJobType(val: string): string { return val; }

  @Option({ flags: '--rate-delay-min <seconds>', description: 'Min request delay (seconds)' })
  parseRateDelayMin(val: string): number { return parseFloat(val); }

  @Option({ flags: '--rate-delay-max <seconds>', description: 'Max request delay (seconds)' })
  parseRateDelayMax(val: string): number { return parseFloat(val); }

  @Option({ flags: '-o, --output <file>', description: 'Write output to file' })
  parseOutput(val: string): string { return val; }

  @Option({ flags: '-v, --verbose', description: 'Verbose output' })
  parseVerbose(): boolean { return true; }

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
