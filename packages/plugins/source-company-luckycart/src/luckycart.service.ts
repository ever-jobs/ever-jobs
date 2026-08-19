import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lucky Cart — MarTech / retail-media platform activating first-party transaction data into personalized shopper offers.
 *
 * SAS Lucky Cart is a French MarTech company that combines first-party
 * transaction data with retail-media capabilities, analyzing point-of-sale
 * data from retailers to build shopper profiles and activate personalized
 * offers in real time. Careers are hosted on Recruitee at
 * luckycart.recruitee.com.
 *
 * Sector: MarTech / Retail media. HQ: Paris, France.
 *
 * Source: Recruitee careers board, subdomain `luckycart`
 * (`https://luckycart.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'luckycart';
const COMPANY_NAME = 'Lucky Cart';

@SourcePlugin({
  site: Site.LUCKY_CART,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LuckyCartService implements IScraper {
  private readonly logger = new Logger(LuckyCartService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Lucky Cart',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lucky Cart: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LUCKY_CART;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'luckycart-');
      }
    }

    this.logger.log(`Lucky Cart: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
