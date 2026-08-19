import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Traackr — Data-driven influencer marketing analytics platform.
 *
 * Traackr provides a data-driven influencer marketing platform that tracks,
 * measures, and analyzes influencer performance and audience data for
 * brands.
 *
 * Sector: Marketing analytics. HQ: San Francisco, California, United States.
 *
 * Source: Lever job board, company slug `traackr`
 * (`https://jobs.lever.co/traackr`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'traackr';
const COMPANY_NAME = 'Traackr';

@SourcePlugin({
  site: Site.TRAACKR,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TraackrService implements IScraper {
  private readonly logger = new Logger(TraackrService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Traackr',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Traackr: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TRAACKR;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'traackr-');
      }
    }

    this.logger.log(`Traackr: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
