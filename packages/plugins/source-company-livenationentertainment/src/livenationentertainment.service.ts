import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Live Nation Entertainment — Live entertainment company spanning concerts, ticketing and venues.
 *
 * Live Nation Entertainment is a live entertainment company that promotes
 * concerts, operates venues and provides ticketing through its ticketing
 * business. It hires across event operations, venue management, marketing
 * and corporate roles.
 *
 * Sector: Live Entertainment & Events. HQ: Beverly Hills, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `LiveNationEntertainment`
 * (`https://jobs.smartrecruiters.com/LiveNationEntertainment`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'LiveNationEntertainment';
const COMPANY_NAME = 'Live Nation Entertainment';

@SourcePlugin({
  site: Site.LIVE_NATION_ENTERTAINMENT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LiveNationEntertainmentService implements IScraper {
  private readonly logger = new Logger(LiveNationEntertainmentService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Live Nation Entertainment',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Live Nation Entertainment: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LIVE_NATION_ENTERTAINMENT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'livenationentertainment-');
      }
    }

    this.logger.log(`Live Nation Entertainment: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
