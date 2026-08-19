import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Hillstone Restaurant Group — Full-service restaurant company operating upscale casual dining concepts in the US.
 *
 * Hillstone Restaurant Group is an American full-service restaurant company
 * founded in 1977. It operates a collection of upscale-casual dining
 * restaurants across the United States under brands including Hillstone,
 * Houston's, and R+D Kitchen. It is headquartered in Beverly Hills,
 * California.
 *
 * Sector: Restaurants (Full-Service). HQ: Beverly Hills, California, USA.
 *
 * Source: SmartRecruiters job board, company identifier `HillstoneRestaurantGroup`
 * (`https://jobs.smartrecruiters.com/HillstoneRestaurantGroup`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'HillstoneRestaurantGroup';
const COMPANY_NAME = 'Hillstone Restaurant Group';

@SourcePlugin({
  site: Site.HILLSTONE_RESTAURANT_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HillstoneRestaurantGroupService implements IScraper {
  private readonly logger = new Logger(HillstoneRestaurantGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Hillstone Restaurant Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Hillstone Restaurant Group: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HILLSTONE_RESTAURANT_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'hillstonerestaurantgroup-');
      }
    }

    this.logger.log(`Hillstone Restaurant Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
