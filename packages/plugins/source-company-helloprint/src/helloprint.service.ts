import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Helloprint — Online marketplace/platform for customizable printed products connecting buyers with local print production.
 *
 * Helloprint is a Rotterdam-based e-commerce platform for customizable
 * printed products, connecting customers with a network of print producers;
 * it is B Corp-certified and also operates a Valencia office. Its careers
 * copy states an AI-first operating model and ~EUR 100M revenue. The
 * Recruitee board helloprint.recruitee.com returned 3 live offers (growth,
 * an AI engineer role, and an open application), all office-first in
 * Rotterdam or Valencia.
 *
 * Sector: E-commerce marketplace (custom print). HQ: Rotterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `helloprint`
 * (`https://helloprint.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'helloprint';
const COMPANY_NAME = 'Helloprint';

@SourcePlugin({
  site: Site.HELLOPRINT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HelloprintService implements IScraper {
  private readonly logger = new Logger(HelloprintService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Helloprint',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Helloprint: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HELLOPRINT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'helloprint-');
      }
    }

    this.logger.log(`Helloprint: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
