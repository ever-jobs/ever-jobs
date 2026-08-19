import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Superellipse — Digital design and engineering studio (innovation agency).
 *
 * Superellipse is an Antwerp-based digital design and engineering studio.
 * Its Recruitee board at superellipse.recruitee.com listed 3 offers,
 * including a digital designer role and internship/open-application listings
 * in Antwerp and Mechelen.
 *
 * Sector: Software / Design & engineering studio. HQ: Antwerp, Belgium.
 *
 * Source: Recruitee careers board, subdomain `superellipse`
 * (`https://superellipse.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'superellipse';
const COMPANY_NAME = 'Superellipse';

@SourcePlugin({
  site: Site.SUPERELLIPSE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SuperellipseService implements IScraper {
  private readonly logger = new Logger(SuperellipseService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Superellipse',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Superellipse: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SUPERELLIPSE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'superellipse-');
      }
    }

    this.logger.log(`Superellipse: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
