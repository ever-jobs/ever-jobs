import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Cruise Planners — US travel agency franchise network specializing in cruises and vacation planning.
 *
 * Cruise Planners is a US-based travel agency franchise network
 * headquartered in Coral Springs, Florida. It supports a network of
 * independent travel advisors selling cruises, tours, and vacation packages,
 * and recruits for corporate and support roles.
 *
 * Sector: Travel. HQ: Coral Springs, Florida, United States.
 *
 * Source: SmartRecruiters job board, company identifier `CruisePlanners`
 * (`https://jobs.smartrecruiters.com/CruisePlanners`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CruisePlanners';
const COMPANY_NAME = 'Cruise Planners';

@SourcePlugin({
  site: Site.CRUISE_PLANNERS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CruisePlannersService implements IScraper {
  private readonly logger = new Logger(CruisePlannersService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Cruise Planners',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Cruise Planners: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CRUISE_PLANNERS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'cruiseplanners-');
      }
    }

    this.logger.log(`Cruise Planners: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
