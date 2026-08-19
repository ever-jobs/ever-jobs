import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Stratas Foods — Manufacturer and distributor of edible oils, shortenings, and dressings.
 *
 * Stratas Foods is a US food manufacturer that produces and distributes
 * edible oils, shortenings, mayonnaise, dressings, and related products for
 * food service, retail, and food ingredient customers. It is a joint venture
 * headquartered in Memphis, Tennessee, with production facilities across the
 * United States.
 *
 * Sector: Food Manufacturing (Oils & Fats). HQ: Memphis, Tennessee, USA.
 *
 * Source: SmartRecruiters job board, company identifier `StratasFoods`
 * (`https://jobs.smartrecruiters.com/StratasFoods`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'StratasFoods';
const COMPANY_NAME = 'Stratas Foods';

@SourcePlugin({
  site: Site.STRATAS_FOODS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StratasFoodsService implements IScraper {
  private readonly logger = new Logger(StratasFoodsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Stratas Foods',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Stratas Foods: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STRATAS_FOODS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'stratasfoods-');
      }
    }

    this.logger.log(`Stratas Foods: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
