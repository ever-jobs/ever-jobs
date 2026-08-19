import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * XSARUS — Digital-commerce agency implementing and optimising e-commerce platforms (Adobe Commerce/Magento, Shopware) and PIM systems.
 *
 * XSARUS is a Dutch digital-commerce agency (founded 2000, ~95 staff) that
 * builds and optimises e-commerce platforms on Adobe Commerce/Magento and
 * Shopware plus PIM systems such as Akeneo and Inriver, serving retail
 * clients including Dille & Kamille and The Sting. The Recruitee board
 * xsarus.recruitee.com returned 5 live offers (PHP development and
 * e-commerce/PIM implementation consultants).
 *
 * Sector: E-commerce implementation agency / retail-tech services. HQ: Middelharnis, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `xsarus`
 * (`https://xsarus.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'xsarus';
const COMPANY_NAME = 'XSARUS';

@SourcePlugin({
  site: Site.XSARUS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class XSARUSService implements IScraper {
  private readonly logger = new Logger(XSARUSService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape XSARUS',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `XSARUS: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.XSARUS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'xsarus-');
      }
    }

    this.logger.log(`XSARUS: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
