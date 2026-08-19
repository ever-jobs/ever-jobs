import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Proforto — E-commerce retailer of workwear, personal protective equipment and safety footwear for professionals.
 *
 * Proforto is a Dutch e-commerce company selling workwear, personal
 * protective equipment (PPE) and safety shoes to professionals across
 * Europe, operating multiple webshops (including ESVSHOP). The Recruitee
 * board proforto.recruitee.com returned 10 live offers spanning recruitment,
 * customer service, logistics (Oosterhout warehouse), sales and supply-chain
 * internships, primarily in Nijmegen.
 *
 * Sector: E-commerce retail (workwear / PPE). HQ: Nijmegen, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `proforto`
 * (`https://proforto.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'proforto';
const COMPANY_NAME = 'Proforto';

@SourcePlugin({
  site: Site.PROFORTO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ProfortoService implements IScraper {
  private readonly logger = new Logger(ProfortoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Proforto',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Proforto: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PROFORTO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'proforto-');
      }
    }

    this.logger.log(`Proforto: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
