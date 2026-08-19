import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Jobs for Humanity — Non-profit platform connecting underrepresented talent with inclusive employers.
 *
 * Jobs for Humanity is a non-profit organization focused on workforce
 * inclusion, connecting historically underrepresented and marginalized job
 * seekers with employers committed to inclusive hiring. It aggregates and
 * hosts a large volume of partner-employer postings on its SmartRecruiters
 * presence.
 *
 * Sector: Non-profit (workforce inclusion / employment). HQ: New York, New York, USA.
 *
 * Source: SmartRecruiters job board, company identifier `jobsforhumanity`
 * (`https://jobs.smartrecruiters.com/jobsforhumanity`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'jobsforhumanity';
const COMPANY_NAME = 'Jobs for Humanity';

@SourcePlugin({
  site: Site.JOBS_FOR_HUMANITY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class JobsForHumanityService implements IScraper {
  private readonly logger = new Logger(JobsForHumanityService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Jobs for Humanity',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Jobs for Humanity: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.JOBS_FOR_HUMANITY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'jobsforhumanity-');
      }
    }

    this.logger.log(`Jobs for Humanity: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
