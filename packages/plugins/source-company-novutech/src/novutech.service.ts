import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Novutech — Digital-transformation and NetSuite consulting partner.
 *
 * Novutech is a Brussels-based digital-transformation consultancy with a
 * team of consultants across Europe. Its Recruitee board at
 * novutech.recruitee.com listed 5 offers, mostly Brussels-based consulting
 * roles plus a tech-consultant role in Paris.
 *
 * Sector: Software / IT consulting. HQ: Brussels, Belgium.
 *
 * Source: Recruitee careers board, subdomain `novutech`
 * (`https://novutech.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'novutech';
const COMPANY_NAME = 'Novutech';

@SourcePlugin({
  site: Site.NOVUTECH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NovutechService implements IScraper {
  private readonly logger = new Logger(NovutechService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Novutech',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Novutech: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NOVUTECH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'novutech-');
      }
    }

    this.logger.log(`Novutech: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
