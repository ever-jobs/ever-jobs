import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Crusoe — Energy-focused cloud infrastructure for AI computing.
 *
 * Crusoe builds and operates data-center and cloud infrastructure for AI
 * workloads, with an emphasis on energy sourcing and GPU compute. It
 * provides cloud services for training and inference.
 *
 * Sector: AI infrastructure / cloud. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `crusoe`
 * (`https://jobs.ashbyhq.com/crusoe`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'crusoe';
const COMPANY_NAME = 'Crusoe';

@SourcePlugin({
  site: Site.CRUSOE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CrusoeService implements IScraper {
  private readonly logger = new Logger(CrusoeService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Crusoe',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Crusoe: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CRUSOE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'crusoe-');
      }
    }

    this.logger.log(`Crusoe: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
