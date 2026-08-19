import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ISEE — Autonomous yard trucks for logistics and distribution operations.
 *
 * ISEE develops autonomous driving technology for yard trucks that move
 * trailers within logistics yards and distribution centers, combining
 * AI-based autonomy with vehicle operations.
 *
 * Sector: Autonomous Vehicles. HQ: Cambridge, Massachusetts, United States.
 *
 * Source: Lever job board, company slug `isee`
 * (`https://jobs.lever.co/isee`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'isee';
const COMPANY_NAME = 'ISEE';

@SourcePlugin({
  site: Site.ISEE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ISEEService implements IScraper {
  private readonly logger = new Logger(ISEEService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape ISEE',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `ISEE: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ISEE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'isee-');
      }
    }

    this.logger.log(`ISEE: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
