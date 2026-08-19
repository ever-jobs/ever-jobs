import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Peripass — Yard-management SaaS that digitizes and automates logistics yard operations.
 *
 * Peripass is a Ghent-based SaaS scale-up providing yard-management software
 * that digitalizes and automates complex logistics environments. Its
 * Recruitee board at peripass.recruitee.com listed 6 offers including
 * product management and sales roles based in Gent and Amsterdam.
 *
 * Sector: Software / Logistics SaaS. HQ: Ghent, Belgium.
 *
 * Source: Recruitee careers board, subdomain `peripass`
 * (`https://peripass.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'peripass';
const COMPANY_NAME = 'Peripass';

@SourcePlugin({
  site: Site.PERIPASS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PeripassService implements IScraper {
  private readonly logger = new Logger(PeripassService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Peripass',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Peripass: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PERIPASS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'peripass-');
      }
    }

    this.logger.log(`Peripass: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
