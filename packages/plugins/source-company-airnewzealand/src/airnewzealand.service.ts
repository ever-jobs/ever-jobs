import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Air New Zealand — New Zealand\'s flag carrier airline, operating domestic and international passenger and cargo services.
 *
 * Air New Zealand is the flag carrier airline of New Zealand, headquartered
 * in Auckland. It provides domestic and international passenger flights
 * along with cargo services across the Pacific, Asia, North America, and
 * beyond.
 *
 * Sector: Airlines. HQ: Auckland, Auckland, New Zealand.
 *
 * Source: SmartRecruiters job board, company identifier `airnewzealand`
 * (`https://jobs.smartrecruiters.com/airnewzealand`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'airnewzealand';
const COMPANY_NAME = 'Air New Zealand';

@SourcePlugin({
  site: Site.AIR_NEW_ZEALAND,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AirNewZealandService implements IScraper {
  private readonly logger = new Logger(AirNewZealandService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Air New Zealand',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Air New Zealand: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AIR_NEW_ZEALAND;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'airnewzealand-');
      }
    }

    this.logger.log(`Air New Zealand: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
