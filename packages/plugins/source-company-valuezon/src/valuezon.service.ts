import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * VALUEZON — Munich-based e-commerce company focused on Amazon marketplace selling, brand-building and performance marketing.
 *
 * VALUEZON GmbH is a Munich-based e-commerce company that sells products and
 * builds brands on Amazon marketplaces and advises clients on Amazon selling
 * and performance marketing. Its Recruitee board (valuezon.recruitee.com)
 * returned a JSON offers array with roles such as 'Business Manager -
 * E-Commerce (m/w/d)', '(Junior) Performance Marketing Manager' and 'Amazon
 * Marketplace Manager (m/w/d)', all in Munich.
 *
 * Sector: E-commerce / Amazon marketplace. HQ: Munich, Germany.
 *
 * Source: Recruitee careers board, subdomain `valuezon`
 * (`https://valuezon.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'valuezon';
const COMPANY_NAME = 'VALUEZON';

@SourcePlugin({
  site: Site.VALUEZON,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VALUEZONService implements IScraper {
  private readonly logger = new Logger(VALUEZONService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape VALUEZON',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `VALUEZON: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VALUEZON;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'valuezon-');
      }
    }

    this.logger.log(`VALUEZON: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
