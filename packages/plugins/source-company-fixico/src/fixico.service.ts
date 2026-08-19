import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Fixico — Digital platform for managing vehicle damage repairs, connecting fleets and insurers with repairers.
 *
 * Fixico is an Amsterdam-based company operating a digital car-repair
 * management platform that connects fleet owners, leasing companies, and
 * insurers with a network of repair shops to steer and manage damage
 * repairs.
 *
 * Sector: Automotive / repair-management platform. HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `fixico`
 * (`https://fixico.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'fixico';
const COMPANY_NAME = 'Fixico';

@SourcePlugin({
  site: Site.FIXICO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FixicoService implements IScraper {
  private readonly logger = new Logger(FixicoService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Fixico',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Fixico: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FIXICO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'fixico-');
      }
    }

    this.logger.log(`Fixico: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
