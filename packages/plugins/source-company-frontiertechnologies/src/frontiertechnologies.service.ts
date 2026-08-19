import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Frontier Technologies — IT services and consulting company specializing in staff augmentation.
 *
 * Frontier Technologies is an IT services and consulting company formed in
 * 2002 that specializes in staff augmentation and customized staffing
 * solutions for technology roles.
 *
 * Sector: IT services and staffing. HQ: Naperville, Illinois, United States.
 *
 * Source: SmartRecruiters job board, company identifier `FrontierTechnologiesLLC1`
 * (`https://jobs.smartrecruiters.com/FrontierTechnologiesLLC1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'FrontierTechnologiesLLC1';
const COMPANY_NAME = 'Frontier Technologies';

@SourcePlugin({
  site: Site.FRONTIER_TECHNOLOGIES,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FrontierTechnologiesService implements IScraper {
  private readonly logger = new Logger(FrontierTechnologiesService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Frontier Technologies',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Frontier Technologies: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FRONTIER_TECHNOLOGIES;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'frontiertechnologies-');
      }
    }

    this.logger.log(`Frontier Technologies: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
