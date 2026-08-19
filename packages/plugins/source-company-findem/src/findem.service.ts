import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Findem — People-intelligence data platform using AI to power talent acquisition analytics.
 *
 * Findem builds a people-intelligence platform that uses AI and enriched
 * attribute data to power talent acquisition, sourcing, and workforce
 * analytics.
 *
 * Sector: People / talent intelligence. HQ: Redwood City, California, United States.
 *
 * Source: Lever job board, company slug `findem`
 * (`https://jobs.lever.co/findem`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'findem';
const COMPANY_NAME = 'Findem';

@SourcePlugin({
  site: Site.FINDEM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FindemService implements IScraper {
  private readonly logger = new Logger(FindemService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Findem',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Findem: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FINDEM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'findem-');
      }
    }

    this.logger.log(`Findem: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
