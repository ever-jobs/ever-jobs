import { Injectable, Logger } from '@nestjs/common';
import {
  ScraperInputDto, JobPostDto, JobResponseDto, Site, IScraper,
  Country, SalarySource, CompensationDto,
} from '@ever-jobs/models';
import { extractSalary, convertToAnnual } from '@ever-jobs/common';
import { LinkedInService } from '@ever-jobs/source-linkedin';
import { IndeedService } from '@ever-jobs/source-indeed';
import { GlassdoorService } from '@ever-jobs/source-glassdoor';
import { ZipRecruiterService } from '@ever-jobs/source-ziprecruiter';
import { GoogleService } from '@ever-jobs/source-google';
import { BaytService } from '@ever-jobs/source-bayt';
import { NaukriService } from '@ever-jobs/source-naukri';
import { BDJobsService } from '@ever-jobs/source-bdjobs';
import { InternshalaService } from '@ever-jobs/source-internshala';
import { ExaService } from '@ever-jobs/source-exa';
import { UpworkService } from '@ever-jobs/source-upwork';
import { AshbyService } from '@ever-jobs/source-ats-ashby';
import { GreenhouseService } from '@ever-jobs/source-ats-greenhouse';
import { LeverService } from '@ever-jobs/source-ats-lever';
import { WorkableService } from '@ever-jobs/source-ats-workable';
import { SmartRecruitersService } from '@ever-jobs/source-ats-smartrecruiters';
import { RipplingService } from '@ever-jobs/source-ats-rippling';
import { WorkdayService } from '@ever-jobs/source-ats-workday';
import { AmazonService } from '@ever-jobs/source-company-amazon';
import { AppleService } from '@ever-jobs/source-company-apple';
import { MicrosoftService } from '@ever-jobs/source-company-microsoft';
import { NvidiaService } from '@ever-jobs/source-company-nvidia';
import { TikTokService } from '@ever-jobs/source-company-tiktok';
import { UberService } from '@ever-jobs/source-company-uber';
import { CursorService } from '@ever-jobs/source-company-cursor';
import { RemoteOkService } from '@ever-jobs/source-remoteok';
import { RemotiveService } from '@ever-jobs/source-remotive';
import { JobicyService } from '@ever-jobs/source-jobicy';
import { HimalayasService } from '@ever-jobs/source-himalayas';
import { ArbeitnowService } from '@ever-jobs/source-arbeitnow';
import { WeWorkRemotelyService } from '@ever-jobs/source-weworkremotely';
import { RecruiteeService } from '@ever-jobs/source-ats-recruitee';
import { TeamtailorService } from '@ever-jobs/source-ats-teamtailor';
import { UsajobsService } from '@ever-jobs/source-usajobs';
import { AdzunaService } from '@ever-jobs/source-adzuna';
import { ReedService } from '@ever-jobs/source-reed';
import { JoobleService } from '@ever-jobs/source-jooble';
import { CareerJetService } from '@ever-jobs/source-careerjet';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly scraperMap: Map<Site, IScraper>;

  constructor(
    private readonly linkedInService: LinkedInService,
    private readonly indeedService: IndeedService,
    private readonly glassdoorService: GlassdoorService,
    private readonly zipRecruiterService: ZipRecruiterService,
    private readonly googleService: GoogleService,
    private readonly baytService: BaytService,
    private readonly naukriService: NaukriService,
    private readonly bdJobsService: BDJobsService,
    private readonly internshalaService: InternshalaService,
    private readonly exaService: ExaService,
    private readonly upworkService: UpworkService,
    private readonly ashbyService: AshbyService,
    private readonly greenhouseService: GreenhouseService,
    private readonly leverService: LeverService,
    private readonly workableService: WorkableService,
    private readonly smartRecruitersService: SmartRecruitersService,
    private readonly ripplingService: RipplingService,
    private readonly workdayService: WorkdayService,
    private readonly amazonService: AmazonService,
    private readonly appleService: AppleService,
    private readonly microsoftService: MicrosoftService,
    private readonly nvidiaService: NvidiaService,
    private readonly tiktokService: TikTokService,
    private readonly uberService: UberService,
    private readonly cursorService: CursorService,
    private readonly remoteOkService: RemoteOkService,
    private readonly remotiveService: RemotiveService,
    private readonly jobicyService: JobicyService,
    private readonly himalayasService: HimalayasService,
    private readonly arbeitnowService: ArbeitnowService,
    private readonly weWorkRemotelyService: WeWorkRemotelyService,
    private readonly recruiteeService: RecruiteeService,
    private readonly teamtailorService: TeamtailorService,
    private readonly usajobsService: UsajobsService,
    private readonly adzunaService: AdzunaService,
    private readonly reedService: ReedService,
    private readonly joobleService: JoobleService,
    private readonly careerJetService: CareerJetService,
  ) {
    this.scraperMap = new Map<Site, IScraper>([
      [Site.LINKEDIN, this.linkedInService],
      [Site.INDEED, this.indeedService],
      [Site.GLASSDOOR, this.glassdoorService],
      [Site.ZIP_RECRUITER, this.zipRecruiterService],
      [Site.GOOGLE, this.googleService],
      [Site.BAYT, this.baytService],
      [Site.NAUKRI, this.naukriService],
      [Site.BDJOBS, this.bdJobsService],
      [Site.INTERNSHALA, this.internshalaService],
      [Site.EXA, this.exaService],
      [Site.UPWORK, this.upworkService],
      [Site.ASHBY, this.ashbyService],
      [Site.GREENHOUSE, this.greenhouseService],
      [Site.LEVER, this.leverService],
      [Site.WORKABLE, this.workableService],
      [Site.SMARTRECRUITERS, this.smartRecruitersService],
      [Site.RIPPLING, this.ripplingService],
      [Site.WORKDAY, this.workdayService],
      [Site.AMAZON, this.amazonService],
      [Site.APPLE, this.appleService],
      [Site.MICROSOFT, this.microsoftService],
      [Site.NVIDIA, this.nvidiaService],
      [Site.TIKTOK, this.tiktokService],
      [Site.UBER, this.uberService],
      [Site.CURSOR, this.cursorService],
      [Site.REMOTEOK, this.remoteOkService],
      [Site.REMOTIVE, this.remotiveService],
      [Site.JOBICY, this.jobicyService],
      [Site.HIMALAYAS, this.himalayasService],
      [Site.ARBEITNOW, this.arbeitnowService],
      [Site.WEWORKREMOTELY, this.weWorkRemotelyService],
      [Site.RECRUITEE, this.recruiteeService],
      [Site.TEAMTAILOR, this.teamtailorService],
      [Site.USAJOBS, this.usajobsService],
      [Site.ADZUNA, this.adzunaService],
      [Site.REED, this.reedService],
      [Site.JOOBLE, this.joobleService],
      [Site.CAREERJET, this.careerJetService],
    ]);
  }


  /** ATS scrapers require a companySlug to target a specific company board */
  private static readonly ATS_SITES = new Set<Site>([
    Site.ASHBY,
    Site.GREENHOUSE,
    Site.LEVER,
    Site.WORKABLE,
    Site.SMARTRECRUITERS,
    Site.RIPPLING,
    Site.WORKDAY,
    Site.RECRUITEE,
    Site.TEAMTAILOR,
  ]);

  /** Company scrapers target a single company's career API directly */
  private static readonly COMPANY_SITES = new Set<Site>([
    Site.AMAZON,
    Site.APPLE,
    Site.MICROSOFT,
    Site.NVIDIA,
    Site.TIKTOK,
    Site.UBER,
    Site.CURSOR,
  ]);

  /**
   * Orchestrates concurrent searching across selected sites.
   * Runs all selected source modules in parallel via Promise.allSettled.
   *
   * Routing rules (when no explicit siteType is provided):
   * - If `companySlug` provided → only ATS scrapers run (they need a slug)
   * - Otherwise → search + company scrapers run (ATS scrapers skipped)
   *
   * When `siteType` is explicitly provided, the filter is always respected
   * regardless of `companySlug`.
   */
  async searchJobs(input: ScraperInputDto): Promise<JobPostDto[]> {
    const explicitSites = input.siteType;
    let sites: Site[];

    if (explicitSites?.length) {
      // Explicit site selection — respect exactly what was requested
      sites = explicitSites;
    } else if (input.companySlug) {
      // companySlug provided but no explicit sites → ATS scrapers only
      sites = [...JobsService.ATS_SITES];
    } else {
      // Default: search + company scrapers (skip ATS — they need a slug)
      sites = Object.values(Site).filter(
        (s) => !JobsService.ATS_SITES.has(s),
      );
    }

    const selectedScrapers: { site: Site; scraper: IScraper }[] = [];

    for (const site of sites) {
      const scraper = this.scraperMap.get(site);
      if (scraper) {
        selectedScrapers.push({ site, scraper });
      } else {
        this.logger.warn(`Unknown site: ${site}`);
      }
    }

    if (selectedScrapers.length === 0) {
      this.logger.warn('No valid scrapers selected');
      return [];
    }

    this.logger.log(`Running ${selectedScrapers.length} scrapers concurrently: ${selectedScrapers.map((s) => s.site).join(', ')}`);

    // Run all scrapers concurrently using Promise.allSettled
    const results = await Promise.allSettled(
      selectedScrapers.map(async ({ site, scraper }) => {
      this.logger.log(`Starting search for ${site}`);
        try {
          const response = await scraper.scrape(input);
          // Tag each job with the site it came from
          for (const job of response.jobs) {
            job.site = site;
          }
          this.logger.log(`${site}: found ${response.jobs.length} jobs`);
          return response;
        } catch (err: any) {
          this.logger.error(`${site} search failed: ${err.message}`);
          throw err;
        }
      }),
    );

    // Aggregate results from fulfilled searches
    const allJobs: JobPostDto[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allJobs.push(...result.value.jobs);
      }
    }

    // Post-processing: salary enrichment (mirrors Python __init__.py logic)
    for (const job of allJobs) {
      this.postProcessSalary(job, input);
    }

    // Sort by site name then by date (most recent first)
    allJobs.sort((a, b) => {
      const siteCompare = (a.site ?? '').localeCompare(b.site ?? '');
      if (siteCompare !== 0) return siteCompare;

      const dateA = a.datePosted ? new Date(a.datePosted as string).getTime() : 0;
      const dateB = b.datePosted ? new Date(b.datePosted as string).getTime() : 0;
      return dateB - dateA;
    });

    this.logger.log(`Total aggregated jobs: ${allJobs.length}`);
    return allJobs;
  }

  /**
   * Post-processes a single job's salary data.
   * If the scraper provided direct compensation, optionally convert to annual.
   * If no compensation was returned and the country is USA, try to parse salary from the description.
   * This mirrors the orchestrator logic for salary post-processing.
   */
  private postProcessSalary(job: JobPostDto, input: ScraperInputDto): void {
    const enforceAnnual = input.enforceAnnualSalary ?? false;
    const country = input.country ?? Country.USA;

    if (job.compensation) {
      // Direct compensation from scraper
      job.salarySource = SalarySource.DIRECT_DATA;

      if (
        enforceAnnual &&
        job.compensation.interval &&
        job.compensation.interval !== 'yearly' &&
        job.compensation.minAmount != null &&
        job.compensation.maxAmount != null
      ) {
        const data = {
          interval: job.compensation.interval,
          minAmount: job.compensation.minAmount,
          maxAmount: job.compensation.maxAmount,
        };
        convertToAnnual(data);
        job.compensation.interval = data.interval as any;
        job.compensation.minAmount = data.minAmount;
        job.compensation.maxAmount = data.maxAmount;
      }
    } else if (country === Country.USA && job.description) {
      // Fallback: extract salary from description text (USA only)
      const extracted = extractSalary(job.description, {
        enforceAnnualSalary: enforceAnnual,
      });
      if (extracted.minAmount != null) {
        job.salarySource = SalarySource.DESCRIPTION;
        job.compensation = new CompensationDto({
          interval: extracted.interval as any,
          minAmount: extracted.minAmount,
          maxAmount: extracted.maxAmount,
          currency: extracted.currency ?? 'USD',
        });
      }
    }

    // Clear salary source if no salary data
    if (!job.compensation?.minAmount) {
      job.salarySource = undefined;
    }
  }
}

