import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * FINN — Car subscription platform offering flexible vehicle access.
 *
 * FINN is a mobility company offering car subscriptions that bundle vehicle,
 * insurance and maintenance into a single flexible plan. It operates in
 * Germany and the United States.
 *
 * Sector: logistics. HQ: Munich, Bavaria, Germany.
 *
 * Source: Lever job board, company slug `finn`
 * (`https://jobs.lever.co/finn`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'finn';
const COMPANY_NAME = 'FINN';

@SourcePlugin({
  site: Site.FINN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FINNService implements IScraper {
  private readonly logger = new Logger(FINNService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape FINN',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `FINN: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FINN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'finn-');
      }
    }

    this.logger.log(`FINN: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
