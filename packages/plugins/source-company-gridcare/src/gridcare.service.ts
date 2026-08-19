import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * GridCARE — Provides software and analysis to speed grid interconnection for new large electricity loads.
 *
 * GridCARE develops software and data analysis to identify available grid
 * capacity and accelerate interconnection for large electricity loads such
 * as data centers. It works with utilities and developers on interconnection
 * studies and utility partnerships. The company is based in Redwood City,
 * California.
 *
 * Sector: Grid / interconnection. HQ: Redwood City, California, USA.
 *
 * Source: Ashby job board, company slug `gridcare`
 * (`https://jobs.ashbyhq.com/gridcare`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'gridcare';
const COMPANY_NAME = 'GridCARE';

@SourcePlugin({
  site: Site.GRIDCARE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class GridCAREService implements IScraper {
  private readonly logger = new Logger(GridCAREService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape GridCARE',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `GridCARE: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.GRIDCARE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'gridcare-');
      }
    }

    this.logger.log(`GridCARE: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
