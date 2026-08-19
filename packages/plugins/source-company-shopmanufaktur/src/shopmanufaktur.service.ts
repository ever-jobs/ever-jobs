import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Shop Manufaktur — Bremen-based e-commerce company operating online shops, with hiring focused on Shopify and online-marketing roles.
 *
 * Shop Manufaktur GmbH is a Bremen-based e-commerce company. Its Recruitee
 * board (shopmanufaktur.recruitee.com) returned a JSON offers array with
 * roles including 'Shopify E-Commerce Manager (m/w/d)', 'Experte für
 * Onlinemarketing (m/w/d)' and office-management positions, all based in
 * Bremen.
 *
 * Sector: E-commerce (online shop operator). HQ: Bremen, Germany.
 *
 * Source: Recruitee careers board, subdomain `shopmanufaktur`
 * (`https://shopmanufaktur.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'shopmanufaktur';
const COMPANY_NAME = 'Shop Manufaktur';

@SourcePlugin({
  site: Site.SHOP_MANUFAKTUR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ShopManufakturService implements IScraper {
  private readonly logger = new Logger(ShopManufakturService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Shop Manufaktur',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Shop Manufaktur: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SHOP_MANUFAKTUR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'shopmanufaktur-');
      }
    }

    this.logger.log(`Shop Manufaktur: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
