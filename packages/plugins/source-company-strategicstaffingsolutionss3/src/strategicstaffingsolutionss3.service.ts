import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Strategic Staffing Solutions (S3) — IT staffing and consulting firm founded in 1990.
 *
 * Strategic Staffing Solutions (S3) is an information technology staffing
 * and consulting firm providing staff augmentation and IT consulting
 * services. Founded in 1990, it is among the larger US staffing firms.
 *
 * Sector: IT staffing and consulting. HQ: Detroit, Michigan, United States.
 *
 * Source: SmartRecruiters job board, company identifier `StrategicStaffingSolutionsS3`
 * (`https://jobs.smartrecruiters.com/StrategicStaffingSolutionsS3`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'StrategicStaffingSolutionsS3';
const COMPANY_NAME = 'Strategic Staffing Solutions (S3)';

@SourcePlugin({
  site: Site.STRATEGIC_STAFFING_SOLUTIONS_S3,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StrategicStaffingSolutionsS3Service implements IScraper {
  private readonly logger = new Logger(StrategicStaffingSolutionsS3Service.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Strategic Staffing Solutions (S3)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Strategic Staffing Solutions (S3): delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STRATEGIC_STAFFING_SOLUTIONS_S3;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'strategicstaffingsolutionss3-');
      }
    }

    this.logger.log(`Strategic Staffing Solutions (S3): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
