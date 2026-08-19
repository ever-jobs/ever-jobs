import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * OSARO — Machine-learning software and robotics for warehouse and manufacturing automation.
 *
 * OSARO develops machine-learning-based perception and control software for
 * industrial robots used in piece-picking and packaging in e-commerce
 * fulfillment and manufacturing.
 *
 * Sector: Robotics. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `osaro`
 * (`https://jobs.lever.co/osaro`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'osaro';
const COMPANY_NAME = 'OSARO';

@SourcePlugin({
  site: Site.OSARO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OSAROService implements IScraper {
  private readonly logger = new Logger(OSAROService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape OSARO',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `OSARO: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OSARO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'osaro-');
      }
    }

    this.logger.log(`OSARO: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
