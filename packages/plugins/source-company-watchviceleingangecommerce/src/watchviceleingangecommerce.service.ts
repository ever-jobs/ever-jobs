import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * WATCHVICE (Leingang E-Commerce) — Luxury-watch e-commerce trading company selling and buying watches such as Rolex, Patek Philippe and Audemars Piguet online.
 *
 * Leingang E-Commerce GmbH, operating the WATCHVICE brand, is a German
 * e-commerce company trading luxury watches (including Rolex, Patek Philippe
 * and Audemars Piguet) online, paired with a large German-language
 * luxury-watch content channel. Its Recruitee board
 * (watchvice.recruitee.com) returned a JSON offers array with sales and
 * back-office roles based in Bietigheim-Bissingen.
 *
 * Sector: E-commerce (luxury watches). HQ: Bietigheim-Bissingen, Germany.
 *
 * Source: Recruitee careers board, subdomain `watchvice`
 * (`https://watchvice.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'watchvice';
const COMPANY_NAME = 'WATCHVICE (Leingang E-Commerce)';

@SourcePlugin({
  site: Site.WATCHVICE_LEINGANG_E_COMMERCE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WATCHVICELeingangECommerceService implements IScraper {
  private readonly logger = new Logger(WATCHVICELeingangECommerceService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape WATCHVICE (Leingang E-Commerce)',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `WATCHVICE (Leingang E-Commerce): delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WATCHVICE_LEINGANG_E_COMMERCE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'watchviceleingangecommerce-');
      }
    }

    this.logger.log(`WATCHVICE (Leingang E-Commerce): scraped ${result.jobs.length} jobs`);
    return result;
  }
}
