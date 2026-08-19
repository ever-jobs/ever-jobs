import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Periodic Labs — AI research company focused on scientific discovery.
 *
 * Periodic Labs is an AI research company applying artificial intelligence
 * to scientific discovery and experimentation, including autonomous
 * laboratory research.
 *
 * Sector: AI research / science. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `periodic-labs`
 * (`https://jobs.ashbyhq.com/periodic-labs`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'periodic-labs';
const COMPANY_NAME = 'Periodic Labs';

@SourcePlugin({
  site: Site.PERIODIC_LABS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class PeriodicLabsService implements IScraper {
  private readonly logger = new Logger(PeriodicLabsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Periodic Labs',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Periodic Labs: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PERIODIC_LABS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'periodiclabs-');
      }
    }

    this.logger.log(`Periodic Labs: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
