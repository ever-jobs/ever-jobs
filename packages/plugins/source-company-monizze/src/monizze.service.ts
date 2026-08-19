import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Monizze — Digital employee-benefits provider (meal, eco, and gift vouchers) via app and card.
 *
 * Monizze is a Brussels-based HR/benefits technology company providing
 * digital employee benefits through a card and app. Its Recruitee board at
 * monizze.recruitee.com listed 6 offers, including Chief Product Officer and
 * product-innovation roles, all Brussels-based.
 *
 * Sector: Software / HR-benefits tech. HQ: Brussels, Belgium.
 *
 * Source: Recruitee careers board, subdomain `monizze`
 * (`https://monizze.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'monizze';
const COMPANY_NAME = 'Monizze';

@SourcePlugin({
  site: Site.MONIZZE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MonizzeService implements IScraper {
  private readonly logger = new Logger(MonizzeService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Monizze',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Monizze: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MONIZZE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'monizze-');
      }
    }

    this.logger.log(`Monizze: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
