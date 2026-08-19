import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * City Furniture — Home furnishings retailer operating furniture showrooms in Florida.
 *
 * City Furniture is a home furnishings retailer operating showrooms across
 * Florida, including Ashley HomeStore locations. It sells furniture,
 * mattresses, and home decor through physical stores and e-commerce. The
 * company is a major furniture retailer in the South Florida market.
 *
 * Sector: Home furnishings retail. HQ: Tamarac, Florida, USA.
 *
 * Source: SmartRecruiters job board, company identifier `CityFurniture1`
 * (`https://jobs.smartrecruiters.com/CityFurniture1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'CityFurniture1';
const COMPANY_NAME = 'City Furniture';

@SourcePlugin({
  site: Site.CITY_FURNITURE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CityFurnitureService implements IScraper {
  private readonly logger = new Logger(CityFurnitureService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape City Furniture',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `City Furniture: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CITY_FURNITURE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'cityfurniture-');
      }
    }

    this.logger.log(`City Furniture: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
