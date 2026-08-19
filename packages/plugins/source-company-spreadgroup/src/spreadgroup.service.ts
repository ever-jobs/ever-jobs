import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Spread Group — Leipzig-based print-on-demand e-commerce group (Spreadshirt, Spreadshop) selling made-to-order customized apparel and lifestyle products.
 *
 * Spread Group is a Leipzig-headquartered print-on-demand e-commerce
 * company, known for its Spreadshirt and Spreadshop brands, providing
 * made-to-order customized apparel and lifestyle products and a platform for
 * creators to sell their own designs. Its Recruitee board
 * (spreadgroup.recruitee.com) returned a JSON offers array with roles such
 * as 'Strategic Partnerships Manager', 'Payment & Treasury Operations
 * Manager' and 'Puncher / Embroidery Specialist'.
 *
 * Sector: E-commerce / print-on-demand marketplace. HQ: Leipzig, Germany.
 *
 * Source: Recruitee careers board, subdomain `spreadgroup`
 * (`https://spreadgroup.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'spreadgroup';
const COMPANY_NAME = 'Spread Group';

@SourcePlugin({
  site: Site.SPREAD_GROUP,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SpreadGroupService implements IScraper {
  private readonly logger = new Logger(SpreadGroupService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Spread Group',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Spread Group: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SPREAD_GROUP;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'spreadgroup-');
      }
    }

    this.logger.log(`Spread Group: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
