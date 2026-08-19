import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Park Avenue Coffee — St. Louis coffee and bakery company operating cafes and a bakery.
 *
 * Park Avenue Coffee is a St. Louis, Missouri coffee and bakery business
 * operating cafes and an in-house bakery known for its gooey butter cake. It
 * hires bakers, baristas, and bakery production staff for its local
 * operations.
 *
 * Sector: Food & Beverage (Coffee & Bakery). HQ: St. Louis, Missouri, USA.
 *
 * Source: SmartRecruiters job board, company identifier `ParkAvenueCoffee`
 * (`https://jobs.smartrecruiters.com/ParkAvenueCoffee`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ParkAvenueCoffee';
const COMPANY_NAME = 'Park Avenue Coffee';

@SourcePlugin({
  site: Site.PARK_AVENUE_COFFEE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ParkAvenueCoffeeService implements IScraper {
  private readonly logger = new Logger(ParkAvenueCoffeeService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Park Avenue Coffee',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Park Avenue Coffee: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PARK_AVENUE_COFFEE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'parkavenuecoffee-');
      }
    }

    this.logger.log(`Park Avenue Coffee: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
