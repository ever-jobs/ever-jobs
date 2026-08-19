import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Pylon — An API platform for embedding mortgage origination and lending.
 *
 * Pylon is a fintech infrastructure company that lets businesses embed
 * mortgage lending into their products via APIs, handling origination,
 * underwriting, processing, funding, and closing. It was founded in 2022 and
 * offers products including conventional, FHA, VA, and jumbo loans.
 *
 * Sector: Fintech - Embedded mortgage lending. HQ: USA.
 *
 * Source: Ashby job board, company slug `pylon`
 * (`https://jobs.ashbyhq.com/pylon`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'pylon';
const COMPANY_NAME = 'Pylon';

@SourcePlugin({
  site: Site.PYLON,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PylonService implements IScraper {
  private readonly logger = new Logger(PylonService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Pylon',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Pylon: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PYLON;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'pylon-');
      }
    }

    this.logger.log(`Pylon: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
