import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * MotherDuck — Cloud data warehouse built on DuckDB for developers and data practitioners.
 *
 * MotherDuck builds a cloud-hosted data warehouse based on the open-source
 * DuckDB analytical database, aimed at developers and data practitioners. It
 * combines local and cloud execution. The company hires across Sales,
 * Engineering, and Customer Success in San Francisco, Seattle, New York
 * City, and Amsterdam.
 *
 * Sector: Databases / Data Warehouse. HQ: Seattle, Washington, USA.
 *
 * Source: Ashby job board, company slug `motherduck`
 * (`https://jobs.ashbyhq.com/motherduck`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'motherduck';
const COMPANY_NAME = 'MotherDuck';

@SourcePlugin({
  site: Site.MOTHERDUCK,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MotherDuckService implements IScraper {
  private readonly logger = new Logger(MotherDuckService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape MotherDuck',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `MotherDuck: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MOTHERDUCK;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'motherduck-');
      }
    }

    this.logger.log(`MotherDuck: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
