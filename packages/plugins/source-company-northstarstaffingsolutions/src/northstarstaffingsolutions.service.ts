import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * North Star Staffing Solutions — Staffing agency placing candidates across multiple industries.
 *
 * North Star Staffing Solutions is a staffing agency that connects job
 * seekers with employers across a range of fields. It provides recruiting
 * and placement services for direct-hire and contract roles.
 *
 * Sector: Staffing and recruiting. HQ: Denver, Colorado, United States.
 *
 * Source: SmartRecruiters job board, company identifier `NorthStarStaffingSolutions1`
 * (`https://jobs.smartrecruiters.com/NorthStarStaffingSolutions1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'NorthStarStaffingSolutions1';
const COMPANY_NAME = 'North Star Staffing Solutions';

@SourcePlugin({
  site: Site.NORTH_STAR_STAFFING_SOLUTIONS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NorthStarStaffingSolutionsService implements IScraper {
  private readonly logger = new Logger(NorthStarStaffingSolutionsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape North Star Staffing Solutions',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `North Star Staffing Solutions: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NORTH_STAR_STAFFING_SOLUTIONS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'northstarstaffingsolutions-');
      }
    }

    this.logger.log(`North Star Staffing Solutions: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
