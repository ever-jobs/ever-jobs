import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Solutions 4 Delivery — SaaS platform for online food ordering and delivery aimed at quick-service restaurant chains.
 *
 * Solutions 4 Delivery is an Amsterdam-based company providing a SaaS
 * online-ordering and delivery platform for quick-service restaurant chains,
 * covering webshop/ordering, logistics and customer operations. Its board
 * solutions4delivery.recruitee.com redirects to the slug s4d.recruitee.com,
 * which returned 10 live offers across operations, growth and product, all
 * in Amsterdam.
 *
 * Sector: Food e-commerce / delivery SaaS. HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `s4d`
 * (`https://s4d.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 's4d';
const COMPANY_NAME = 'Solutions 4 Delivery';

@SourcePlugin({
  site: Site.SOLUTIONS_4_DELIVERY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class Solutions4DeliveryService implements IScraper {
  private readonly logger = new Logger(Solutions4DeliveryService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Solutions 4 Delivery',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Solutions 4 Delivery: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SOLUTIONS_4_DELIVERY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'solutions4delivery-');
      }
    }

    this.logger.log(`Solutions 4 Delivery: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
