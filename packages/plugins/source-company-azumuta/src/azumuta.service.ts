import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Azumuta — Manufacturing SaaS for digital work instructions, quality, and shop-floor operations.
 *
 * Azumuta is a Ghent-based manufacturing-software scale-up helping factories
 * digitalize operations, improve efficiency, and manage quality and safety.
 * Its Recruitee board at azumuta.recruitee.com listed 6 offers, mostly
 * product-engineering roles in Gent plus a sales role in the Netherlands.
 *
 * Sector: Software / Manufacturing SaaS. HQ: Ghent, Belgium.
 *
 * Source: Recruitee careers board, subdomain `azumuta`
 * (`https://azumuta.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'azumuta';
const COMPANY_NAME = 'Azumuta';

@SourcePlugin({
  site: Site.AZUMUTA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AzumutaService implements IScraper {
  private readonly logger = new Logger(AzumutaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Azumuta',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Azumuta: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.AZUMUTA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'azumuta-');
      }
    }

    this.logger.log(`Azumuta: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
