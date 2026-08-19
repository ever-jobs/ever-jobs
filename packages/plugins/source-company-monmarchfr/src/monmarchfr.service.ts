import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Mon-marché.fr — E-commerce and logistics platform delivering fresh grocery products to homes.
 *
 * Mon-marché.fr is a French e-commerce company delivering fresh and
 * ultra-fresh grocery products directly to customers, operating logistics
 * for perishable goods primarily in the Île-de-France region. Careers are
 * hosted on Recruitee at monmarchefr.recruitee.com.
 *
 * Sector: E-commerce / Grocery tech. HQ: Île-de-France, France.
 *
 * Source: Recruitee careers board, subdomain `monmarchefr`
 * (`https://monmarchefr.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'monmarchefr';
const COMPANY_NAME = 'Mon-marché.fr';

@SourcePlugin({
  site: Site.MON_MARCH_FR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MonMarchFrService implements IScraper {
  private readonly logger = new Logger(MonMarchFrService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Mon-marché.fr',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Mon-marché.fr: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MON_MARCH_FR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'monmarchfr-');
      }
    }

    this.logger.log(`Mon-marché.fr: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
